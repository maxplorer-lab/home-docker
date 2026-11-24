# Home on Docker + SQLite

The **whole super app in one container**: Sompitra (budget, Kiné, debts, sales,
medicine cupboard), W.A.Y (live map, trips, geofences), Laoka (meal planner,
pantry), the family chat, the public live share, the admin console — behind one
central login. It runs the **real Cloudflare Worker** (`src/index.tsx`) on
workerd, Wrangler's local runtime, with D1 and both Durable Objects backed by
SQLite under `/data`. No Cloudflare account, no D1 row limits, no second app.

## Why the Worker, and not a Node port

W.A.Y's dashboard is built on `FleetDO` (the live socket, `pending_sync`, the
nightly flush, approach pulses) and Laoka on its `Lobby`. A Node re-implementation
would be a second app that has to keep proving it agrees with the first. Running
the Worker itself means the routes, schema, gates and Durable Objects are the
same code the deployed instance runs; the container only supplies storage and a
process to host it.

| Piece | In this container |
| --- | --- |
| Pages and APIs | the Worker's own routes and assets from `public/` |
| `HOME_DB`, `WAY_DB`, `DB`, `LAOKA_DB` | two SQLite files (see below), opened by workerd |
| `FleetDO`, `Lobby` | workerd Durable Objects, SQLite-backed, under `data/state/` |
| Cron `0 21 * * *` | the entrypoint calls `/__scheduled` daily at 21:00 UTC |
| Login, cookies, session repair | unchanged, including the four module cookies |
| ntfy | the Worker's own `src/lib/notify.ts`, if `NTFY_URL` is set |

## Data layout

| Path | Holds | Bindings |
| --- | --- | --- |
| `data/home.sqlite` → live file | central login (`users`, `sessions`, invites, settings, notification channels, diagnostics) **and W.A.Y** (`way_users`, `gps_pings`, `geofences`, `devices`, `messages`) | `HOME_DB`, `WAY_DB` |
| `data/sompitra.sqlite` → live file | finance (`transactions`, accounts, categories, Kiné, debts, sales, stock), `medications`, and **Laoka** (`laoka_users`, `laoka_sessions`, `weeks`, pantry) | `DB`, `LAOKA_DB` |
| `data/state/` | the files workerd actually opens: D1 under `v3/d1/…`, Durable Object storage under `v3/do/…` | — |
| `data/state/d1-paths.json` | the two live D1 paths, relative to `/data`. `server/config.mjs` reads it so every Node tool opens the same file workerd does. Do not edit. The live files are owned by the container's root, so run the tools with `docker compose exec`/`run`. | — |
| `data/auth_pepper`, `data/session_secret` | generated once, mode `0600`; required to verify existing passwords and sessions | — |

The friendly names are **symlinks** to files whose names are hashes of the
database identity. Workerd will not open a symlink, and SQLite derives its
`-wal`/`-shm` names from the path it is given — so the live file is the real one,
and the Node tools resolve their target through `d1-paths.json`. Opening the
link from two places at once would give one database two WAL sidecars and two
writers that do not coordinate. One path per database, always.

Two files, not one, because both schemas define `users` and `sessions`. This is
also why each Cloudflare D1 export drops into its own file.

## What is included

* **Sompitra** — Budget, Kiné, Debts & Credits, Sales & Stock, Categories,
  Reports, and the medicine cupboard, all behind `/login`.
* **W.A.Y** — `/way/`: the live map with the delayed playback cursor and follow
  camera, Trips, history, geofences, per-person map settings, users & topics,
  μlogger ingest at `/ulogger`, the approach pulse and its three announcements
  (push, chat row, badge).
* **Laoka** — `/laoka/`: the weekly planner, shopping list, pantry and to-buy
  list, CSV export, and the two hand-offs into a Sompitra expense.
* **Chat** — `/chat`: the family room on the same `/ws` socket and FleetDO as
  W.A.Y, including system pills for money, Kiné and geofence events.
* **Live share** — `/live`: a 6-digit code shows one device's map to somebody
  without an account, until midnight UTC or an admin revokes it.
* **Admin** — `/admin`, `/settings`, `/admin/diagnostics` (the ingest gate
  ledger and the notification ledger).
* **PWA** — the root manifest and the `/way/` manifest and service workers.
* **The nightly flush** — accepted pings and chat rows live in the DO until
  21:00 UTC, then are copied into `gps_pings` and `messages` idempotently.

Not part of this build: Cloudflare's edge, its email/WAF features, or a second
replica. Wrangler's local runtime is a development runtime; it is the real
Worker code, but it is not the Cloudflare network.

## Quick start

```bash
docker compose up -d --build
```

Open `http://localhost:8080/login`. A **fresh** volume has no accounts: open
`/bootstrap` and create the first one (it becomes the admin). An imported
database already has its accounts — use those, or mint a first-sign-in link
(below).

`AUTH_PEPPER` and `SESSION_SECRET` are optional for a brand-new install (both
are generated into `data/`). They are **required** to verify passwords and
sessions imported from Cloudflare; see [Moving the data](#moving-the-data).

The health check is `GET /login`; there is no `/healthz` in the Worker.

## Phones (μlogger)

In μlogger's server settings:

| Setting | Value |
| --- | --- |
| Server URL | `https://your-host/ulogger` (or `http://localhost:8080/ulogger`) |
| Username | the person's **Home** username |
| Password | that person's **Home** password |

`action=auth` sets `way_device_session`, `action=addtrack` returns a `trackid`,
and `action=addpos` uploads fixes. `speed` is in **m/s** and `time` in
**seconds**; the route converts speed to km/h. Changing `SESSION_SECRET` signs
every phone out once; each re-authenticates on its next upload.

The intake gates are the Worker's, in its order:

1. accuracy worse than **10 m** is dropped whole;
2. a reported speed above **120 km/h** loses only that field (`null`, never
   clamped);
3. a reported speed is believed only when the coordinates corroborate movement
   (a parked phone's 5–30 km/h claim is replaced by the speed the positions
   imply);
4. a fix implying more than **120 km/h** is dropped whole, including the
   same-second floor;
5. an unwitnessed fence crossing moves the live dot but writes no history.

**Every filtered fix still answers success**, so μlogger does not retry it. A
real storage failure answers an error body and is logged; `/admin/diagnostics`
counts every deliberate silence.

### What becomes history

An accepted fix is broadcast live immediately. It is queued for history only
when the persistence decision says it draws a point (outside every fence and
not collapsed as stationary); the queue is the DO's `pending_sync`, copied to
`gps_pings` by the nightly flush. A phone parked at home therefore writes no
rows while its badge still updates. A departure writes the interpolated
fence-edge point plus the confirming fix.

Until the flush, history is in Durable Object storage. That is why a backup of
a running machine can be up to one day behind in `gps_pings`, and why stopping
the container cleanly (and letting it flush first) matters.

### A quick protocol check

```bash
B=http://localhost:8080
curl -i -c /tmp/devjar \
  -d 'action=auth&user=maxx&pass=your-password' "$B/ulogger"
curl -b /tmp/devjar -d 'action=addtrack' "$B/ulogger"
curl -b /tmp/devjar \
  -d 'action=addpos&trackid=1&lat=-19.8796&lon=47.0309&time='$(date +%s)'&speed=5&accuracy=5&altitude=900' \
  "$B/ulogger"
```

A fix at your own fence is accepted but not stored. Drive it out, or use a
coordinate outside every fence, to see it on `/way/` and in the next flush.

## The app's own pages

All of these answer after `/login`:

```
/            /budget      /kine       /debts      /sales
/meds        /categories  /settings   /admin      /admin/diagnostics
/way/        /laoka/      /chat       /live
```

`/live` is the one public page (a code only, `noindex`). `/way/`, `/laoka/` and
`/chat` are session-gated module shells around their own documents.

The admin console's **Flush now** and the diagnostics page are the quickest way
to force the nightly copy without waiting for 21:00 UTC:

```bash
docker compose exec home node -e \
  "fetch('http://127.0.0.1:8080/__scheduled?cron=0+21+*+*+*').then(r=>console.log(r.status))"
```

## Accounts and first sign-in links

An import carries history, not logins. `server/users.mjs` writes the central
login, the Sompitra row (matched by username, so attribution survives) and the
W.A.Y row the phone authenticates with — one password, in each module's format:

```bash
docker compose exec home ./node_modules/.bin/tsx server/users.mjs list
docker compose exec home ./node_modules/.bin/tsx server/users.mjs set maxx \
  --name MaxX --admin --invite
```

With `--invite` the command prints a one-time link instead of a password:

```
[users]   first sign-in link (one-time, 14 days):
[users]     /claim?token=…
```

Prefix it with the site address, or set `PUBLIC_URL` so the whole URL is
printed. The token is stored only as a SHA-256 hash, expires after 14 days, and
stops working when used. On an account that already has a password, `--invite`
does **not** change it; `set` without `--invite` resets the password everywhere
(browser and phone) without changing the person's id.

Every account creation needs `AUTH_PEPPER`; keep it with the data.

## Storage, the flush and pruning

* The DO queue is flushed at **21:00 UTC** (W.A.Y's midnight, UTC+3). The
  container triggers the Worker's scheduled handler itself because a local
  runtime has no cron trigger.
* `gps_pings` is append-only and has no automatic pruning. Delete deliberately,
  after a backup:

```bash
docker compose stop
docker compose run --rm home node -e '
  const D = require("better-sqlite3");
  const fs = require("fs");
  const map = JSON.parse(fs.readFileSync("/data/state/d1-paths.json", "utf8"));
  const db = new D(map.home);
  const cut = new Date(Date.now() - 365 * 864e5).toISOString();
  console.log(db.prepare("DELETE FROM gps_pings WHERE timestamp < ?").run(cut).changes, "rows removed");
'
docker compose start
```

`timestamp` is an ISO instant, so the cutoff is an ISO string too.

## Backups

The only durable path is `/data`. Stop the container first, then copy the whole
directory — `state/` holds the live SQLite files (including Durable Object
storage) and the pepper files:

```bash
docker compose stop
tar czf home-backup-$(date +%F).tgz data
docker compose start
```

While it runs, use the online backup API below — a bare `cp -L` of the main
file would miss WAL frames that have not been checkpointed, and it does not
include Durable Object scrollback that has not flushed. With the container
stopped, `cp -L data/home.sqlite` does resolve the link to the live file and is
a valid copy; the `tar` above is still simpler because it takes the whole
volume.

The runtime image has no `sqlite3` CLI, but it has `better-sqlite3`; the online
backup API works on a live machine:

```bash
node -e '
  const D=require("better-sqlite3"), fs=require("fs");
  const map=JSON.parse(fs.readFileSync("/data/state/d1-paths.json","utf8"));
  for (const [k,p] of Object.entries(map)) {
    const db=new D(p,{readonly:true});
    db.backup(`/data/${k}-backup.sqlite`).then(()=>{db.close();console.log(k,"done")});
  }
'
```

Then copy those two files off the machine — that off-machine copy **is** the
backup.

## Moving the data from Cloudflare

### Option A — D1 dumps (seamless)

From the repository that owns `wrangler.jsonc`:

```bash
mkdir -p data/import
npx wrangler d1 export home-db    --remote --output=./data/import/home.sql
npx wrangler d1 export sompitra-db --remote --output=./data/import/sompitra.sql
```

Import **before the first boot**, with the container stopped:

```bash
docker compose build
docker compose run --rm home \
  node server/import.mjs sql /data/import/sompitra.sql --db sompitra --fresh
docker compose run --rm home \
  node server/import.mjs sql /data/import/home.sql --db home --fresh
```

`--fresh` deletes that target first; never point it at a database that has
already recorded data. On an existing install the live-path map exists, so the
import targets the files workerd owns — stop the container, import, start.

Put the **production pepper** in `.env` before starting:

```bash
AUTH_PEPPER=<the exact value from `wrangler secret`>
SESSION_SECRET=<the W.A.Y secret, optional>
```

Without the matching pepper the rows import fine but every Sompitra password
hash fails to verify. `PBKDF2_ITERATIONS` affects new hashes only; existing rows
carry their own count.

The import reports table/row counts and foreign-key violations (rows are kept).
On the next boot the migrator detects the complete schema and records the
migrations instead of re-running them — in particular it does not re-apply
`0008_admin.sql` to every account. It also applies any missing `migrations-way/`
file, runs the `devices` FK repair when needed, and applies `migrations-laoka/`
into `sompitra.sqlite`.

### Option B — CSV exports

CSV import is for a Sompitra export. One file per table is ideal, but a single
ledger export works if its headers contain `date` and `amount`.

```bash
mkdir -p data/import/csv
docker compose stop
docker compose run --rm home node server/import.mjs csv /data/import/csv
docker compose start
```

| Option | Meaning |
| --- | --- |
| `--table transactions` | override the table derived from the filename |
| `--dry-run` | read and count, write nothing |
| `--db home` | import into `home.sqlite` instead of `sompitra.sqlite` |

The transactions importer accepts `YYYY-MM-DD` and `DD/MM/YYYY`, amounts with
`Ar`, spaces, commas or a decimal point (a typed `1250.75` is 1,250 — the app's
whole-Ariary rule), and resolves `category` + `group`, `account` and `added_by`
names case-insensitively, creating what is missing. Missing `type` means
expense; `income`/`in`/`credit` are accepted. Rows without ids get UUIDs; a
re-import of a file with ids updates the same rows, except `users`, where an
existing username is kept because transactions point at its id.

## Verification

```bash
curl -sf http://localhost:8080/login >/dev/null && echo "up"
# inside, after login:
#   /  /budget  /kine  /debts  /sales  /meds  /categories  /settings
#   /admin  /admin/diagnostics  /way/  /laoka/  /chat  /live
docker compose exec home node server/migrate.mjs
docker compose exec home node --import tsx server/users.mjs list
```

The repository's checks:

```bash
npm run check
npm test
npm run verify     # check + test + smoke (smoke wants `npm run dev`)
```

`scripts/container-tracking.test.mjs` still exercises the legacy Node port
(`npm run start:node`), not the Worker runtime; the container's own end-to-end
check is the page list above plus one μlogger upload and one chat message.

## Fly.io

`fly.toml` is included, deliberately as **one machine**:

```bash
# change `app` in fly.toml to a name you own, then:
fly volumes create home_data --region jnb --size 1
fly secrets set AUTH_PEPPER=... SESSION_SECRET=...
# --ha=false is not optional: flyctl creates TWO machines for a new app by
# default, which doubles the bill and splits the single SQLite writer.
fly deploy --ha=false
fly machine list          # must print exactly one machine
```

Why the settings matter:

* **One machine, one volume.** SQLite and the Durable Objects are
  single-writer. `fly scale count 2` would be two databases and a split live
  feed. `min_machines_running = 1` and `auto_stop_machines = false` keep the
  phone's upload from cold-starting the machine.
* **`/data` is the only durable path.** A deploy replaces the container's own
  filesystem; the volume holds `state/`, the two friendly links and both
  secrets.
* **`force_https = true`.** μlogger must use the `https://` URL; the login
  cookie is `Secure` when the request looks like HTTPS.
* **Health check** — `GET /login` on port 8080, with a 45 s grace period while
  workerd bundles and boots.
* **Memory** — 512 MB. The full runtime measured ~432 MB in `docker stats`
  (entrypoint, Wrangler supervisor, workerd and page cache); 256 MB is not
  enough. Watch `fly machine status` after a deploy.

### Cost

One always-on machine is the only real cost; two users and twenty cost the
same. At Fly's prices in `jnb` (regional multiplier 1.303):

| Line | Monthly |
| --- | --- |
| `shared-cpu-1x`, 512 MB | ~$4.96 |
| 1 GB volume | $0.15 |
| Egress (two phones, ~0.1–0.3 GB) | ~$0.03 |
| **Total** | **~$5.14** |
| Free-plan allowance | −$5.00 |
| **Charged** | **~$0.14** |

That is right at the Free plan's **$5 cliff**: a month over the allowance is
billed from the first cent at standard rates, not just the excess. Keep a
billing alert on, and check `fly machine status` after a deploy. The old 256 MB
figure belonged to the stripped Node port and is no longer enough for the real
Worker.

The plan's other limits fit: 3 machines (one used), 5 GB per volume (1 used),
1 org member (the household accounts are app accounts), shared CPU only, and a
shared IPv4 supplied by `http_service`.

Two jobs stay yours: **offsite backups** (Fly's snapshots live on Fly) and
**uptime** (one machine is one point of failure).

## Single-writer rules

* SQLite on a network share opened by two hosts is corruption. Never run two
  containers against the same `/data`.
* The Node tools and workerd must open the **same path** for a database. They
  do, through `state/d1-paths.json`; do not add a tool that opens the friendly
  symlink while the container is running.
* The Durable Objects own the live socket, `pending_sync` and the chat
  scrollback. They are not a second source of truth for config (which lives in
  D1) — a config write signals the DO, it does not copy rows into it.
* Rotating `SESSION_SECRET` invalidates browser sessions and every phone's
  device cookie (phones re-authenticate). Rotating `AUTH_PEPPER` invalidates
  every password hash.
