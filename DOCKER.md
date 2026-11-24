# Home on Docker + SQLite

A container build of the **Sompitra** finance suite plus **live GPS tracking**:
Budget, Kiné, Debts & Credits, Sales & Stock, Categories and the medicine
cupboard, μlogger's upload protocol at `/ulogger`, and a login-protected
`/track` page fed by `/ws`. It runs the same routes and server-rendered pages
as the Cloudflare Worker, on two SQLite files instead of D1. No daily row
limits and no Durable Objects.

| File | Holds | Bindings |
| --- | --- | --- |
| `data/home.sqlite` | central login (`users`, `sessions`, `attempts`, settings, notification channels, the diagnostics ledger) **and the WAY tracking tables** (`way_users`, `gps_pings`, `geofences`, `devices`, plus the container-only `device_state`) | `HOME_DB`, `WAY_DB` |
| `data/sompitra.sqlite` | the finance data (`transactions`, accounts, categories, Kiné, debts, sales, stock, `medications`) | `DB`, `LAOKA_DB` |

Two files, not one, because both schemas define `users` and `sessions`. This is
also why each Cloudflare D1 export drops into its own file.

## What is included

* **Sompitra** — the finance pages and the medicine cupboard, behind the
  central `/login`.
* **μlogger ingest** — `/ulogger` and `/ulogger/*` speak the phone's existing
  protocol (`action=auth`, `addtrack`, `addpos`). The device session cookie is
  the same `way_device_session`; passwords are W.A.Y's `salt:hash` PBKDF2-100k
  format, so an imported `way_users` row keeps working.
* **Live view** — `/track` is a small login-protected page of device cards.
  `/ws` sends a `snapshot` on connect and a `position` frame for every accepted
  ping, so the cards update without a page refresh. It reconnects with backoff.
* **ntfy** for Sompitra notifications, if `NTFY_URL` is set. The chat mirror is
  skipped because `FLEET_DO` is not bound; ntfy is independent of it.
* `/healthz` for a container or Fly health check, and `/track`'s link from the
  dashboard.

## What is NOT in this build

* **WAY's map and history UI** — no map, trips, GPX, geofence editor or
  approach pulses. Positions are still stored in `gps_pings`; `/track` cards
  show the latest fix and link out to OpenStreetMap in a new tab.
* **Laoka, the family chat and the public `/live` share** — their paths answer
  a plain explanation page and 404. `/laoka-ws` is not served.
* **W.A.Y notifications** — no geofence/arrival/approach pushes. This build
  reports positions; it does not run the DO's notification engine.
* **A pause / forced-mode control, or a retention job.** `device_state` has the
  fields, but nothing in this UI sets them, and `gps_pings` has no automatic
  pruning (see [Storage](#storage-and-pruning)).
* **A login rate limiter on `/ulogger`.** Sompitra's login has one; the phone
  endpoint authenticates per request and relies on the device password. Put the
  container behind a proxy/WAF if it is exposed to the open internet and you
  want per-IP throttling there.

## Quick start (fresh install)

```bash
docker compose up -d --build
```

Open `http://localhost:8080/bootstrap` and create the first account. The first
account is the admin. It is provisioned into the existing Sompitra `users` row
by username, so an imported database keeps its attribution.

Then sign in once at `/login`. **`/bootstrap` does not create a `way_users`
row** (it has no separate password hash step); the first normal login does, and
that is the account μlogger authenticates with. If a person is added later at
`/admin`, they must also sign in once before their phone can authenticate.

`AUTH_PEPPER` is optional for a fresh install (one is generated into
`data/auth_pepper`). It is **required** to verify passwords imported from
Cloudflare — see below.

## Phones (μlogger)

In μlogger's server settings:

| Setting | Value |
| --- | --- |
| Server URL | `https://your-host/ulogger` (or `http://localhost:8080/ulogger` locally) |
| Username | the person's **Home** username |
| Password | that person's **Home** password |

The phone then does what it always did: `action=auth` returns a
`way_device_session` cookie, `action=addtrack` returns a `trackid`, and
`action=addpos` uploads fixes. `speed` is in **m/s** and `time` in **seconds**;
the route converts speed to km/h. The existing session cookie is signed with
`SESSION_SECRET`; changing that secret signs every phone out once, and they
re-authenticate on the next upload.

The same intake gates as the Worker apply, in the same order:

1. accuracy worse than **10 m** is dropped whole;
2. a reported speed above **120 km/h** loses only that field (`null`, never
   clamped);
3. a reported speed is believed only when the coordinates corroborate movement
   (a parked phone's 5–30 km/h claim is replaced by the speed the positions
   imply);
4. a fix implying more than **120 km/h** is dropped whole (including the
   same-second floor);
5. an unwitnessed fence crossing moves the live dot but writes no history.

**Every filtered fix still answers success**, so μlogger does not retry it. A
real storage failure is different: it answers an error body and logs it.

### What becomes history

An accepted ping is **always broadcast** to `/track`; it becomes a `gps_pings`
row only when it is **outside every fence and not stationary** — the same
`!isInside && !isStationary` rule as `FleetDO.shouldPersistTrackPoint`. A phone
parked at home therefore writes no rows while its live card still updates. A
departure writes the interpolated fence-edge point plus the confirming fix.
There is no `pending_sync` buffer and no nightly flush: the row is written as
the ping arrives.

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

A fix at your own fence is accepted but not stored. Drive it out (or use a
coordinate outside every fence) to see a `position` frame and a row.

## Live view

`/track` requires `home_session`; it is not public. It opens
`ws(s)://<host>/ws` and reads the existing W.A.Y frame names:

```json
{ "type": "snapshot", "devices": { "maxx": { "deviceId": "maxx", "latitude": 0, "longitude": 0, "speed": 0, "accuracy": 0, "timestamp": "..." } }, "serverTime": "..." }
{ "type": "position", "deviceId": "maxx", "latitude": 0, "longitude": 0, "speed": 0, "stored": true, "...": "..." }
```

The socket verifies the Home session during the HTTP upgrade and rejects a
browser `Origin` naming a different host. It sends a snapshot immediately, so a
reconnect needs no page reload. A heartbeat terminates dead clients, and a
client whose send buffer grows past 2 MB is disconnected rather than making the
process buffer the world. The cards are written with `textContent` only.

`stored` is part of the frame on purpose: the dot can move while the fix is
inside a fence or the phone is parked, even though no history row was written.

## Storage and pruning

* `gps_pings` is written through on each accepted fix; there is no flush step.
* `device_state` is one row per device and holds the motion engine's small JSON
  state (bounded buffers, not a history).
* The persistence throttle is what keeps the file small: a parked phone at home
  produces **no** `gps_pings` rows, only live frames.
* There is **no automatic pruning**. If you keep years of tracks, delete old
  rows deliberately (back up first):

```bash
docker compose exec home node -e '
  const D = require("better-sqlite3");
  const db = new D("/data/home.sqlite");
  const cut = new Date(Date.now() - 365 * 864e5).toISOString();
  console.log(db.prepare("DELETE FROM gps_pings WHERE timestamp < ?").run(cut).changes, "rows removed");
'
```

`timestamp` is stored as an ISO instant; the comparison is a string comparison,
which is why the cutoff is an ISO string too.

## Moving the Cloudflare data

### Option A — exact D1 dumps (seamless)

Export both databases with Wrangler, from the repository that owns
`wrangler.jsonc`:

```bash
mkdir -p data/import
npx wrangler d1 export sompitra-db --remote --output=./data/import/sompitra.sql
npx wrangler d1 export home-db    --remote --output=./data/import/home.sql
```

Import them **before the first `up`** (or with the container stopped):

```bash
docker compose build

docker compose run --rm home \
  node server/import.mjs sql /data/import/sompitra.sql --db sompitra --fresh

docker compose run --rm home \
  node server/import.mjs sql /data/import/home.sql --db home --fresh
```

`--fresh` deletes that target SQLite file first; it is the explicit flag for
"this import replaces the database". Never run it against a container that has
already recorded data.

Put the **production pepper** in the environment before starting:

```bash
# .env next to docker-compose.yml
AUTH_PEPPER=<the exact value from `wrangler secret`>
SESSION_SECRET=<the W.A.Y secret, optional here>
```

Without the matching pepper the rows import fine but every Sompitra password
hash fails to verify. In that case open `/bootstrap` only if `home.sqlite` has
no users; otherwise reset the password from the admin console of the old
deployment, or create a new account and keep the Sompitra rows (they are linked
by username).

The import prints the table and row counts and reports foreign-key violations
(rows are kept). On the next boot the migrator detects the complete schema and
records the migrations instead of re-running them — in particular it does not
re-apply `0008_admin.sql` to every account.

`home.sql` already contains the W.A.Y tables (`way_users`, `gps_pings`,
`geofences`; `devices` may be absent because `migrations-way/0002` drops it).
The boot migrator applies the missing `migrations-way/` files, recreates
`devices` through `scripts/repair-way-messages-fk.sql` when the FK parent is
missing, and creates the container-only `device_state` table. Do not expect
`device_state` in a D1 export: production does not have it.

`PBKDF2_ITERATIONS` affects **new** hashes only. Existing rows carry their own
iteration count, so leaving the container's value at 5000 does not invalidate
imported passwords. `AUTH_PEPPER` still has to match, because it is the pepper,
not the iteration count.

### Option B — CSV exports

CSV import is for a Sompitra export, not for the whole app. One file per table
is ideal (`transactions.csv`, `customers.csv`, `service_contracts.csv`, …), but
a single ledger export works too: if the headers contain `date` and `amount`,
the file is imported as `transactions` even when it is called something else.

```bash
mkdir -p data/import/csv
# copy the CSV files there, then:
docker compose run --rm home \
  node server/import.mjs csv /data/import/csv
```

Options:

| Option | Meaning |
| --- | --- |
| `--table transactions` | override the table derived from the filename |
| `--dry-run` | read and count, write nothing |
| `--db home` | import into `home.sqlite` instead of `sompitra.sqlite` |

The transactions importer is deliberately forgiving about the shape of a
hand-made export:

* **Dates** accept `YYYY-MM-DD` and `DD/MM/YYYY`; anything else is parsed by
  JavaScript's `Date`.
* **Amounts** may carry `Ar`, spaces, commas or a decimal point; a typed
  `1250.75` is read as 1,250 (the app's own whole-Ariary rule). The report's own
  headers `Amount (MGA)` and `Income Source` are recognized as they are.
* **Names instead of ids**: `category` + `group`, `account` and `added_by` are
  resolved case-insensitively, and missing groups/categories/accounts/users are
  created (a group defaults to `Imported`). `category_id`,
  `income_account_id` and `added_by_user_id` are used when present.
* **Missing `type`** means expense. Accepts `income`/`in` (and `credit`).
* **Ids** are optional; a row without one gets a UUID. A re-import of a file
  that carries ids updates the same row — except `users`, where an existing
  username is kept: replacing it would change the id every transaction,
  contract and payment points at. A report without ids therefore imports once;
  a second run would add its rows again.

### Household accounts (a CSV carries history, not logins)

`sompitra.sqlite.users` has no usable password — the login lives in
`home.sqlite` — so create the two people after importing. One command writes
the central login, the Sompitra row (matched by username, so the imported
history keeps its attribution) and the `way_users` row the phone
authenticates with, all with the same password:

```bash
docker compose run --rm home ./node_modules/.bin/tsx server/users.mjs set maxx \
  --name MaxX --admin
docker compose run --rm home ./node_modules/.bin/tsx server/users.mjs set niri \
  --name Niri
```

Without `--password` a strong one is generated and printed once; pass
`--password '…'` to choose it. `--admin` is the central role (and Sompitra's
`is_admin` fallback); without it the account is a member. Running `set` again
resets that person's password everywhere — browser and phone — without touching
their id. `list` shows every account, which module rows exist, and whether a
first-sign-in link is open.

### Letting them choose their own password (`--invite`)

`--invite` creates the account and prints a **one-time first-sign-in link**
instead of handing out a password. The person opens it, picks their own
password, and is signed in:

```bash
docker compose run --rm home ./node_modules/.bin/tsx server/users.mjs set maxx \
  --name MaxX --admin --invite
# [users]   first sign-in link (one-time, 14 days):
# [users]     /claim?token=…
```

Prefix that path with the site's address (`http://localhost:8080/claim?token=…`),
or set `PUBLIC_URL` and the command prints the whole URL. The token is shown
once and stored only as a SHA-256 hash, so a lost link is replaced by running
the command again (which mints a new one and retires the old one). It expires
after 14 days and stops working the moment it is used.

On a **new** account the generated password is internal and never printed. On an
account that already has a password, `--invite` mints the link without changing
that password — a re-minted expired link cannot sign somebody out. The claim
form writes the chosen password to the central login **and** to the W.A.Y and
Laoka rows, so the phone's μlogger credential changes with it; `/change-password`
does the same.

Locally the same command is `npm run user -- set maxx --admin`. The CSV
importer always processes `users.csv` first, because
`transactions.added_by_user_id` has to point at the row that file creates.

Every CSV import runs the schema migrator first, so a fresh `data/` directory
works in one command. Stop the container while importing (SQLite handles
concurrent reads/writes, but a stopped service is easier to reason about).

## Verification

```bash
curl -sf http://localhost:8080/healthz
# 200 on every page after login:
#   /  /budget  /kine  /debts  /sales  /meds  /categories  /settings  /track
```

Inside the container:

```bash
docker compose exec home node server/migrate.mjs
# "[home] home: imported schema detected..." or "up to date"
```

The repository's checks:

```bash
npm run check          # tsc --noEmit
npm test               # node --test, including scripts/container-tracking.test.mjs
npm run verify         # check + test + smoke (smoke needs `npm run dev`, Cloudflare routes)
```

`scripts/container-tracking.test.mjs` starts the container's source server on a
throwaway SQLite directory and proves: bootstrap/login, μlogger auth, the
accuracy/glitch/reported-speed gates, the fence persistence throttle, the
SQLite rows, the WebSocket snapshot + `position`, `/track` gating, and ping
persistence across a restart. `npm run smoke` is the Cloudflare end-to-end
suite; it is not the container check.

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

* **One machine, one volume.** SQLite and the in-process WebSocket hub are
  single-writer. Do not `fly scale count 2`; two machines would be two
  databases and split the live feed. `min_machines_running = 1` and
  `auto_stop_machines = false` keep the phone's upload from cold-starting the
  container and timing out.
* **`/data` is the only durable path.** A deploy replaces the container's own
  filesystem; the volume holds both databases, `auth_pepper` and
  `session_secret`. Back it up before changes.
* **`force_https = true`.** μlogger must be configured with the `https://` URL;
  the login cookie is `Secure` when the request looks like HTTPS.
* **Health check** — `/healthz` on port 8080.
* **Volume size** — 1 GB is plenty for a household's journey rows with the
  throttle, but the file is append-only. Monitor it and `fly volumes extend`
  before it fills; add the prune above if you want a fixed ceiling.

### Cost: the Free plan is enough

The machine is the only real cost, and it is fixed: SQLite plus the in-process
hub means **one always-on machine**, so two users and twenty cost the same.
The size was measured, not guessed — the built image under a 256 MB cap:

| | |
| --- | --- |
| RSS after boot + migrations | 82 MB |
| RSS after 100 page requests | 83 MB |
| 256 MB cap | 32% used, no OOM, no restarts |

At Fly's prices (checked 2026-11-24), in `jnb` (regional multiplier 1.303):

| Line | Monthly |
| --- | --- |
| `shared-cpu-1x`, 256 MB | $2.86 |
| 1 GB volume | $0.15 |
| Egress (Africa rate, two phones, ~0.1–0.3 GB) | ~$0.03 |
| **Total** | **~$3.04** |
| Free-plan allowance | −$5.00 |
| **Charged** | **$0** |

That leaves ~$2 of headroom, which is the whole point: **the $5 is a cliff, not
a meter.** A month that exceeds it is billed from the first cent at standard
rates, and the Free plan's limits stop applying — so the 512 MB default
(~$4.96, which one 31-day month or a traffic burst pushes over) is the
configuration to avoid. `fly.toml` pins 256 MB for that reason; raise it only
after measuring.

The Free plan's other limits all fit this app: 3 machines (it runs one), 5 GB
per volume (it uses 1), 1 org member (the two users are app accounts, not Fly
users), shared CPU only, and a shared IPv4 — which is what `http_service`
provisions, free. Dedicated IPv4 and static egress IPs are not available on
the plan and are not needed here.

Do these once:

1. **Add a card** to the Fly org — the $5 allowance requires one; without it
you only get a one-time $1 credit for 7 days.
2. **Set a billing alert** in the dashboard. Fly emails when $1 of the
allowance remains, which is the early warning for the cliff.
3. **Deploy with `--ha=false`** and confirm `fly machine list` shows one
machine. A second machine is not just double compute: it is a second SQLite
writer and a split live feed.

Two things stay your job because no plan includes them: **offsite backups**
(Fly's snapshots live on Fly — `fly sftp get` the `.sqlite` files, below) and
**uptime** (one machine is one point of failure). If you want to chase a lower
regional multiplier, `iad` is 1.0× (256 MB ≈ $2.19), but every μlogger upload
then crosses the Atlantic from Madagascar; the latency is not worth $0.67.

Back up a running Fly machine with SQLite's online backup API. The runtime
image does **not** ship the `sqlite3` CLI, but it does have `better-sqlite3`:

```bash
fly ssh console
# inside the machine:
node -e "const D=require('better-sqlite3'); const db=new D('/data/home.sqlite',{readonly:true}); db.backup('/data/home-backup.sqlite').then(()=>{console.log('home backup done'); db.close()})"
node -e "const D=require('better-sqlite3'); const db=new D('/data/sompitra.sqlite',{readonly:true}); db.backup('/data/sompitra-backup.sqlite').then(()=>{console.log('sompitra backup done'); db.close()})"
```

Then copy them off the volume — that off-machine copy **is** the backup,
because Fly's own snapshots live on Fly:

```bash
mkdir -p backups
fly sftp get /data/home-backup.sqlite     ./backups/home-$(date +%F).sqlite
fly sftp get /data/sompitra-backup.sqlite ./backups/sompitra-$(date +%F).sqlite
```

Stopping the machine first and copying `data/` (including `-wal`/`-shm`) is
equally valid.

## Realtime design (what replaced the DO)

The Cloudflare build uses two Durable Objects: `FleetDO` for `/ws` (GPS, chat,
scrollback, `pending_sync`, nightly flush) and `Lobby` for `/laoka-ws`. This
build implements the **tracking** half only, with `server/realtime.mjs`:

* `ws` gives a WebSocket server on the same `/ws` path and the same
  `snapshot`/`position` frame names.
* `Map`/`Set` of sockets replaces `getWebSockets()`; `broadcast()` loops over
  them. A single Node process is the single writer.
* `device_state` and `gps_pings` are ordinary SQLite tables; writes are
  synchronous through `better-sqlite3`, so ordering is preserved for one
  process. There is no `pending_sync` and no flush.
* Auth is `home_session` during the HTTP upgrade, not a W.A.Y device cookie.
  The phone never opens the socket.
* No alarm is needed because there is no nightly copy; a future retention job
  can be a timer.

If the chat or Laoka is ever ported, the same shape applies: keep the existing
paths and frame shapes, use a hub per process, and keep exactly one writer per
SQLite file. **Do not put a SQLite file on a network share and open it from two
hosts.** For more than one replica, add Redis/NATS for fan-out and keep writes
on one machine.

## Backups and exposure

* Stop the container, copy `data/` (both files plus their `-wal`/`-shm`
  siblings), and restart. Or use `sqlite3 data/sompitra.sqlite ".backup ..."`
  while it runs.
* Put the container behind a TLS-terminating reverse proxy (or Fly's edge).
  Session cookies are `Secure` only when the request looks like HTTPS (or
  localhost), so plain HTTP on a LAN address still works — deliberately,
  matching the Worker's behaviour.
* `data/auth_pepper` and `data/session_secret` are generated on first boot with
  mode `0600`; back them up with the databases or every session is invalidated.
* Rotating `SESSION_SECRET` invalidates browser sessions and every phone's
  device cookie; phones re-authenticate. Rotating `AUTH_PEPPER` invalidates
  every password hash.
