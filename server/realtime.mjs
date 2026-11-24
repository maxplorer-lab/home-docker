// ─── The live feed, without a Durable Object ────────────────────
// The Cloudflare build's /ws is answered by FleetDO. Here it is an ordinary
// Node WebSocket server on the same path and, deliberately, the same
// `snapshot` + `position` frame names the existing dashboard already reads.
//
// A Durable Object gives four things: a single writer per key, WebSocket
// fan-out, durable state and alarms. A single Node process gives the first
// two directly; the durable state is SQLite (server/tracking.mjs), and there
// is no alarm to keep because the container writes pings through instead of
// flushing them nightly.
//
// Auth is the central Home session, not the W.A.Y cookie: the browser holding
// `home_session` is already signed in, and /track is a Home page. The phone
// never opens this socket.

import { WebSocket, WebSocketServer } from 'ws'
import { HOME_COOKIE, getHomeUserFromCookie } from '../src/identity'
import { readCookieValue } from '../src/lib/cookies'

const MAX_BUFFERED_BYTES = 2 * 1024 * 1024
const HEARTBEAT_MS = 30_000

function reject(socket, status, text) {
  try {
    socket.write(
      `HTTP/1.1 ${status} ${text}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain\r\n' +
      `Content-Length: ${Buffer.byteLength(text)}\r\n\r\n` +
      text
    )
  } catch {
    // The socket may already be gone; closing below is enough.
  }
  socket.destroy()
}

/** True when a browser Origin names the same host the request arrived on.
 *  Non-browser clients send no Origin and are allowed through the cookie
 *  check, which is what the tests and a future native client need. */
function originIsSameHost(origin, host) {
  if (!origin) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

export function attachRealtime(server, { env, tracking }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  const clients = new Set()

  const broadcast = (payload) => {
    if (clients.size === 0) return
    let data
    try {
      data = JSON.stringify(payload)
    } catch {
      return
    }
    for (const ws of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue
      // A phone on a slow link must not make the process buffer the world.
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        ws.terminate()
        clients.delete(ws)
        continue
      }
      try {
        ws.send(data)
      } catch {
        // One dead client must not break the fan-out to the rest.
      }
    }
  }

  tracking.setBroadcast(broadcast)

  const onUpgrade = async (request, socket, head) => {
    let url
    try {
      url = new URL(request.url, 'http://localhost')
    } catch {
      socket.destroy()
      return
    }
    if (url.pathname !== '/ws') {
      socket.destroy()
      return
    }
    if (!originIsSameHost(request.headers.origin, request.headers.host)) {
      reject(socket, 403, 'Forbidden')
      return
    }

    const token = readCookieValue(request.headers.cookie, HOME_COOKIE)
    const user = token
      ? await getHomeUserFromCookie(env.HOME_DB, token).catch(() => null)
      : null
    if (!user) {
      reject(socket, 401, 'Unauthorized')
      return
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.isAlive = true
      ws.user = user
      clients.add(ws)

      ws.on('pong', () => { ws.isAlive = true })
      ws.on('error', () => {
        clients.delete(ws)
        try { ws.terminate() } catch { /* already gone */ }
      })
      ws.on('close', () => clients.delete(ws))

      // A reconnect must not need a page reload: the snapshot is the whole
      // current world, exactly like the DO's.
      tracking.snapshot()
        .then((frame) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
        })
        .catch((err) => {
          console.error('[realtime] snapshot failed:', err)
        })
    })
  }

  server.on('upgrade', onUpgrade)

  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (ws.isAlive === false) {
        ws.terminate()
        clients.delete(ws)
        continue
      }
      ws.isAlive = false
      try { ws.ping() } catch { /* closed between the check and now */ }
    }
  }, HEARTBEAT_MS)
  if (typeof heartbeat.unref === 'function') heartbeat.unref()

  return {
    broadcast,
    close() {
      clearInterval(heartbeat)
      server.off('upgrade', onUpgrade)
      for (const ws of clients) {
        try { ws.close(1001, 'server shutting down') } catch { /* already gone */ }
      }
      clients.clear()
      wss.close()
    },
  }
}
