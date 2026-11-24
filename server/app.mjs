// ─── The container's Hono app ───────────────────────────────────
// Same Sompitra routes as the Worker, mounted in the same order, with the
// module shells omitted. Auth is still the central Home login: `home_session`
// is minted by /login, and provisioning links it to the existing Sompitra user
// row (which is what an imported database already holds).
//
// Two additions are the container's reason to exist: `/ulogger` (the phones)
// and `/ws` + `/track` (the live view). They reuse WAY's protocol, state
// machine and gates; everything stateful is SQLite. The full WAY map, Laoka
// and the chat stay in the Cloudflare build.

import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'

import { configureChrome } from '../src/views/app-chrome'
import { handleIngest } from '../src/way/routes/ingest'
import * as authModule from '../src/routes/auth'
import * as dashboardModule from '../src/routes/dashboard'
import * as budgetModule from '../src/routes/budget'
import * as kineModule from '../src/routes/kine'
import * as debtsModule from '../src/routes/debts'
import * as salesModule from '../src/routes/sales'
import * as categoriesModule from '../src/routes/categories'
import * as medsModule from '../src/routes/meds'
import * as trackModule from '../src/routes/track'
import * as settingsModule from '../src/routes/local-settings'

// The routes are TSX compiled by tsx. Because package.json is CommonJS, the
// ESM wrapper around each module puts the Hono app behind `default.default`
// (module.exports → { default: app }). Unwrap until the object really is a
// Hono instance, and fail loudly rather than mounting `undefined`.
function appOf(mod, name) {
  let value = mod?.default ?? mod
  for (let depth = 0; depth < 4 && value && !Array.isArray(value.routes); depth += 1) {
    if (!value.default) break
    value = value.default
  }
  if (!value || !Array.isArray(value.routes)) {
    throw new Error(`route module "${name}" did not export a Hono app`)
  }
  return value
}

// The tab bar and the desktop nav both read this one list. Sompitra's sections
// share the `money` tab; Meds and You are the only other screens this build
// actually serves. `tracking` turns on the dashboard's link to /track — the
// Cloudflare build leaves it off because its map is the WAY tab.
configureChrome({ tabs: ['money', 'meds', 'settings'], tracking: true })

export function createApp({ tracking } = {}) {
  if (!tracking) throw new Error('createApp needs the tracking pipeline')

  const app = new Hono()

  // Health check for the container (and for a Fly health check).
  app.get('/healthz', (c) => c.json({ ok: true, app: 'home-sompitra', tracking: true }))

  // The service worker belongs to the full cloud build (it caches /shared and
  // is wired to the module assets). Here it would only serve stale pages.
  app.get('/sw.js', (c) => c.body(null, 404))

  // Modules that are not part of this build: say so instead of serving their
  // documents unauthenticated or 404ing a tab with no explanation.
  const unavailable = (name) => (c) =>
    c.html(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${name} is not in this build</title>` +
      `<body style="font:15px/1.6 system-ui;max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#111">` +
      `<h1 style="font-size:1.35rem">${name} is not part of this build</h1>` +
      `<p style="color:#555">This container hosts the Sompitra finance suite and live GPS tracking. ` +
      `The WAY map, Laoka, the family chat and the public live share live in the Cloudflare build.</p>` +
      `<p><a href="/" style="color:#0f766e">Back to Home</a></p>`,
      404,
    )

  for (const [path, name] of [
    ['/way', 'W.A.Y'],
    ['/laoka', 'Laoka'],
    ['/chat', 'Chat'],
    ['/live', 'The live share'],
    ['/laoka-ws', 'Laoka realtime'],
  ]) {
    app.all(path, unavailable(name))
    app.all(path + '/*', unavailable(name))
  }

  // A browser never GETs /ws — the upgrade is intercepted in server/index.mjs
  // before Hono. This only answers a confused client honestly.
  app.get('/ws', (c) => c.text('WebSocket upgrade required', 426))

  // ── μlogger ingest ──────────────────────────────────────────
  // The phone speaks its own fixed protocol: action=auth, then addtrack, then
  // addpos. handleIngest owns that protocol and the device session; the sink
  // is the SQLite pipeline. A filtered ping still answers success.
  const ingest = (c) => handleIngest(c.req.raw, c.env, (body) => tracking.ingest(body))
  app.all('/ulogger', ingest)
  app.all('/ulogger/*', ingest)

  // Static assets run BEFORE Sompitra's catch-all `use('*', requireAuth)`.
  // Otherwise a signed-out request for /icons/icon-192.png is answered with a
  // redirect to /login — including the icon the sign-in page itself shows.
  // A path with no file falls through (`next()`) to the page routes below, so
  // `/`, `/login` and `/track` are unaffected.
  app.use('*', serveStatic({ root: './public' }))

  // /track is mounted BEFORE the dashboard: the dashboard's `use('*', ...)`
  // is a catch-all, and registering its sub-app first would let it answer a
  // path it does not own.
  app.route('/track', appOf(trackModule, 'track'))

  // Sompitra's own pages — auth first, then the catch-all requireAuth routes,
  // exactly as src/index.tsx orders them.
  app.route('/', appOf(authModule, 'auth'))
  app.route('/', appOf(dashboardModule, 'dashboard'))
  app.route('/budget', appOf(budgetModule, 'budget'))
  app.route('/kine', appOf(kineModule, 'kine'))
  app.route('/debts', appOf(debtsModule, 'debts'))
  app.route('/sales', appOf(salesModule, 'sales'))
  app.route('/categories', appOf(categoriesModule, 'categories'))
  app.route('/meds', appOf(medsModule, 'meds'))
  app.route('/settings', appOf(settingsModule, 'settings'))

  app.notFound((c) => c.text('Not found', 404))

  app.onError((err, c) => {
    console.error(`[home] ${c.req.method} ${c.req.path} failed:`, err)
    return c.text(`Something went wrong.\n\n${err instanceof Error ? err.message : String(err)}`, 500)
  })

  return app
}
