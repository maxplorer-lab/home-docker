import { serve } from '@hono/node-server'
import { ensureDataDir } from './config.mjs'
import { migrateAll } from './migrate.mjs'
import { createApp } from './app.mjs'
import { createEnv } from './env.mjs'
import { createTracking } from './tracking.mjs'
import { attachRealtime } from './realtime.mjs'

ensureDataDir()
migrateAll()

const { env, close } = createEnv()
// The tracking pipeline owns device_state and the ping writes; the app and the
// socket share this one instance so a frame and the row it describes cannot
// come from two different ideas of the device.
const tracking = await createTracking(env)
const app = createApp({ tracking })
const port = Number(process.env.PORT || 8080)
const hostname = process.env.HOST || '0.0.0.0'

const server = serve(
  {
    fetch: (request) => app.fetch(request, env),
    port,
    hostname,
  },
  (info) => {
    console.log(`[home] Sompitra + live tracking on SQLite listening on http://${hostname}:${info.port}`)
    console.log(`[home] data directory: ${process.env.DATA_DIR || './data'}`)
    console.log('[home] μlogger ingest: /ulogger · live feed: /ws · page: /track')
  },
)

// /ws is an HTTP upgrade, not a Hono route: the hub verifies the central Home
// session and then takes over the socket.
const realtime = attachRealtime(server, { env, tracking })

let closing = false
function shutdown(signal) {
  if (closing) return
  closing = true
  console.log(`[home] ${signal} — closing`)
  realtime.close()
  server.close(() => {
    try {
      close()
    } finally {
      process.exit(0)
    }
  })
  // Do not hang if a keep-alive socket refuses to end.
  setTimeout(() => process.exit(0), 5000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
