// End-to-end test for the container's two new doors: μlogger ingest and the
// live WebSocket feed. It boots the REAL server (tsx, migrations and all) in a
// temp data directory, because the thing worth testing is the wiring the
// Worker does not have: protocol -> gates -> state machine -> SQLite -> socket.
//
// Run with `npm test` (node --test). It needs no external service and no
// network beyond loopback.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import WebSocket from 'ws'

const ROOT = process.cwd()
const PEPPER = '0123456789abcdef'
const SECRET = '0123456789abcdef'
// A seeded fence. The test drives OUT of it: the persistence rule (the same
// one FleetDO.shouldPersistTrackPoint uses) writes only outside fences and
// only while not stationary, so a device parked at home writes no history.
const HOME1 = { lat: -19.87962180226231, lon: 47.03093237266988 }

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function setCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie()
  const raw = response.headers.get('set-cookie')
  return raw ? raw.split(/,(?=\s*[A-Za-z0-9_-]+=)/) : []
}

function cookiePair(response, name) {
  for (const header of setCookies(response)) {
    const pair = header.split(';')[0].trim()
    if (pair.startsWith(name + '=')) return pair
  }
  return null
}

async function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-track-'))
  const port = await freePort()
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      HOST: '127.0.0.1',
      AUTH_PEPPER: PEPPER,
      SESSION_SECRET: SECRET,
      PBKDF2_ITERATIONS: '1000',
      TZ: 'UTC',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })

  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited\n${output}`)
    try {
      const res = await fetch(base + '/healthz')
      if (res.ok) return { child, base, port, dataDir, logs: () => output }
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  child.kill('SIGKILL')
  throw new Error(`server did not start\n${output}`)
}

async function stopServer(server) {
  if (server.child.exitCode === null) server.child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => server.child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ])
  if (server.child.exitCode === null) server.child.kill('SIGKILL')
  fs.rmSync(server.dataDir, { recursive: true, force: true })
}

function postForm(base, pathname, fields, cookie) {
  return fetch(base + pathname, {
    method: 'POST',
    // The auth screens answer 302 on purpose. Following it would replace the
    // status (and the Set-Cookie) the test is asserting on.
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(fields),
  })
}

function pingRows(server) {
  const db = new Database(path.join(server.dataDir, 'home.sqlite'), { readonly: true })
  try {
    return db.prepare('SELECT * FROM gps_pings ORDER BY id').all()
  } finally {
    db.close()
  }
}

function waitForFrame(socket, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage)
      reject(new Error('timed out waiting for a WebSocket frame'))
    }, timeoutMs)
    function onMessage(data) {
      let frame
      try { frame = JSON.parse(String(data)) } catch { return }
      if (!predicate || predicate(frame)) {
        clearTimeout(timer)
        socket.off('message', onMessage)
        resolve(frame)
      }
    }
    socket.on('message', onMessage)
  })
}

test('container: μlogger ingest, gates, SQLite and the live socket', { timeout: 120_000 }, async () => {
  const server = await startServer()
  try {
    // ── First-run claim ───────────────────────────────────────
    const boot = await postForm(server.base, '/bootstrap', {
      username: 'maxx',
      display_name: 'MaxX',
      password: 'testpass123',
    })
    assert.equal(boot.status, 302, boot.status + '\n' + server.logs())
    const bootstrapCookie = cookiePair(boot, 'home_session')
    assert.ok(bootstrapCookie, 'bootstrap must set home_session\n' + server.logs())

    // Bootstrap signs the first admin in but does NOT provision the module
    // rows (it has no password on that path). A real sign-in does, and the
    // phones authenticate against the WAY row it creates -- so the test must
    // use the same door a person does.
    const login = await postForm(server.base, '/login', {
      username: 'maxx',
      password: 'testpass123',
    })
    assert.equal(login.status, 302, 'login: ' + login.status + '\n' + server.logs())
    const homeCookie = cookiePair(login, 'home_session') || bootstrapCookie

    // ── μlogger protocol ──────────────────────────────────────
    const auth = await postForm(server.base, '/ulogger', {
      action: 'auth',
      user: 'maxx',
      pass: 'testpass123',
    })
    assert.equal(auth.status, 200, 'auth: ' + auth.status + '\n' + server.logs())
    const deviceCookie = cookiePair(auth, 'way_device_session')
    assert.ok(deviceCookie, 'auth must set the device session\n' + server.logs())

    const wrong = await postForm(server.base, '/ulogger', {
      action: 'auth',
      user: 'maxx',
      pass: 'not-the-password',
    })
    assert.equal(wrong.status, 401)

    const track = await postForm(server.base, '/ulogger', { action: 'addtrack' }, deviceCookie)
    assert.equal(track.status, 200)
    assert.equal((await track.json()).trackid, 1)

    const noSession = await postForm(server.base, '/ulogger', {
      action: 'addpos',
      trackid: '1',
      lat: String(HOME1.lat),
      lon: String(HOME1.lon),
      time: String(Math.floor(Date.now() / 1000)),
    })
    assert.equal(noSession.status, 401)

    let clock = Math.floor(Date.now() / 1000) - 120
    const addpos = (fields) => postForm(server.base, '/ulogger', {
      action: 'addpos',
      trackid: '1',
      time: String(clock),
      ...fields,
    }, deviceCookie)

    // A real departure. The first fixes are inside Home1 (no history -- the
    // point is the fence interior), then the device drives out. The exit has a
    // 30 s guard, so nothing is stored until the sixth fix confirms it; that
    // one writes the fence-edge point AND the confirming fix.
    let res
    clock += 10
    res = await addpos({
      lat: String(HOME1.lat),
      lon: String(HOME1.lon),
      speed: '0',
      accuracy: '5',
      altitude: '900',
    })
    assert.equal(res.status, 200)
    assert.equal(pingRows(server).length, 0, 'a fix inside the fence is not history')

    // 55 m per 10 s (18 km/h). 0.0005 deg of latitude is ~55.6 m here.
    const departure = [0.0005, 0.001, 0.0015, 0.002, 0.0025]
    for (const step of departure) {
      clock += 10
      res = await addpos({
        lat: String(HOME1.lat + step),
        lon: String(HOME1.lon),
        speed: '5',
        accuracy: '5',
        altitude: '900',
      })
      assert.equal(res.status, 200)
    }
    assert.equal(
      pingRows(server).length, 2,
      'the confirmed exit writes the interpolated edge point and the fix'
    )

    // Accuracy beyond the 10 m gate: acknowledged, never stored.
    clock += 10
    res = await addpos({
      lat: String(HOME1.lat + 0.003),
      lon: String(HOME1.lon),
      speed: '0',
      accuracy: '50',
    })
    assert.equal(res.status, 200, 'a filtered ping still answers success')
    assert.equal(pingRows(server).length, 2, 'a bad-accuracy fix must not be stored')

    // Two kilometres in ten seconds is 720 km/h: dropped whole.
    clock += 10
    res = await addpos({
      lat: String(HOME1.lat + 0.02),
      lon: String(HOME1.lon),
      speed: '0',
      accuracy: '5',
    })
    assert.equal(res.status, 200)
    assert.equal(pingRows(server).length, 2, 'a glitch fix must not be stored')

    // A plausible move is stored, and a 360 km/h REPORT loses only itself.
    clock += 10
    res = await addpos({
      lat: String(HOME1.lat + 0.0035),
      lon: String(HOME1.lon),
      speed: '3',
      accuracy: '5',
    })
    assert.equal(res.status, 200)
    assert.equal(pingRows(server).length, 3)

    clock += 10
    res = await addpos({
      lat: String(HOME1.lat + 0.004),
      lon: String(HOME1.lon),
      speed: '100', // m/s == 360 km/h
      accuracy: '5',
    })
    assert.equal(res.status, 200)
    const rows = pingRows(server)
    assert.equal(rows.length, 4)
    assert.equal(rows[3].speed, null, 'a reported speed above the limit is discarded, not stored')

    // ── Live socket ───────────────────────────────────────────
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { cookie: homeCookie },
    })
    const snapshot = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no snapshot')), 5000)
      socket.on('open', () => {})
      waitForFrame(socket, (frame) => frame.type === 'snapshot', 5000)
        .then((frame) => { clearTimeout(timer); resolve(frame) })
        .catch(reject)
    })
    assert.equal(snapshot.type, 'snapshot')
    assert.ok(snapshot.devices.maxx, 'the snapshot must carry the device that has reported')

    const position = waitForFrame(socket, (frame) => frame.type === 'position', 5000)
    clock += 10
    res = await addpos({
      lat: String(HOME1.lat + 0.0045),
      lon: String(HOME1.lon),
      speed: '2',
      accuracy: '4',
    })
    assert.equal(res.status, 200)
    const frame = await position
    assert.equal(frame.type, 'position')
    assert.equal(frame.deviceId, 'maxx')
    assert.ok(Math.abs(frame.latitude - (HOME1.lat + 0.0045)) < 1e-12)
    socket.close()

    const anonymous = new WebSocket(`ws://127.0.0.1:${server.port}/ws`)
    const anonymousResult = await new Promise((resolve) => {
      anonymous.on('unexpected-response', (_request, response) => resolve(response.statusCode))
      anonymous.on('error', () => resolve('error'))
      setTimeout(() => resolve('timeout'), 5000)
    })
    assert.ok(anonymousResult === 401 || anonymousResult === 'error', 'a socket without a session must be refused')
    try { anonymous.terminate() } catch { /* already gone */ }

    // ── The page is gated, and the repair path makes it work ──
    let page = await fetch(server.base + '/track', { redirect: 'manual' })
    assert.equal(page.status, 302)
    assert.match(page.headers.get('location') || '', /\/login$/)

    page = await fetch(server.base + '/track', {
      headers: { cookie: homeCookie },
      redirect: 'manual',
    })
    assert.equal(page.status, 200, 'the home session must repair the Sompitra session\n' + server.logs())
    const html = await page.text()
    assert.match(html, /id="live-devices"/)
    assert.match(html, /\/shared\/track\.js/)

    // ── The row is durable across a restart ──────────────────
    const before = pingRows(server).length
    server.child.kill('SIGTERM')
    await new Promise((resolve) => server.child.once('exit', resolve))
    const restarted = await startServerWithData(server.dataDir, server.port)
    try {
      assert.equal(pingRows({ dataDir: server.dataDir }).length, before)
      const health = await fetch(restarted.base + '/healthz')
      assert.equal(health.status, 200)
    } finally {
      await stopServer(restarted)
    }
  } finally {
    if (server.child.exitCode === null) await stopServer(server)
  }
})

/** Reuse an existing data directory (the restart/durability half). */
async function startServerWithData(dataDir, port) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      HOST: '127.0.0.1',
      AUTH_PEPPER: PEPPER,
      SESSION_SECRET: SECRET,
      PBKDF2_ITERATIONS: '1000',
      TZ: 'UTC',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`restart failed\n${output}`)
    try {
      const res = await fetch(base + '/healthz')
      if (res.ok) return { child, base, port, dataDir, logs: () => output }
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  child.kill('SIGKILL')
  throw new Error(`restart did not start\n${output}`)
}
