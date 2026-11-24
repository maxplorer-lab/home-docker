#!/usr/bin/env node
// ─── The container's real super app ──────────────────────────────
// The Node port could only ever be one module: WAY's dashboard and chat are
// built on a Durable Object, Laoka on its Lobby, and re-implementing those in
// process would be a second app pretending to be the first. So the container
// runs the REAL Worker instead — the same `src/index.tsx`, D1 schema, Durable
// Objects and cron — on workerd (Wrangler's local runtime), with every byte of
// state in SQLite under /data. No Cloudflare account is involved.
//
// The one thing this file owns is the data layout:
//
//   /data/state/v3/d1/…/<hash>.sqlite   the live D1 files (workerd opens these)
//   /data/home.sqlite  ────────────────▶ symlink to the live home-db file
//   /data/sompitra.sqlite ─────────────▶ symlink to the live sompitra-db file
//
// The friendly names stay, so `ls`, a backup and the docs keep working. The
// live paths are also written to /data/state/d1-paths.json, and server/config.mjs
// opens THOSE: SQLite derives -wal/-shm from the path it is handed, so a tool
// opening the link would create one database's second WAL and two writers that
// do not coordinate. One path per database, always.
//
// A data directory from the old Node build is adopted on first boot: its two
// real files are checkpointed, copied to the live names once, then replaced by
// the links. Subsequent boots only apply missing migrations and start the
// Worker.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

const ROOT = process.cwd()
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'))
// config.mjs resolves DATA_DIR when it is imported, so set it first.
process.env.DATA_DIR = DATA_DIR
const { ensureDataDir, loadSecret } = await import('./config.mjs')

const STATE_DIR = path.resolve(process.env.STATE_DIR || path.join(DATA_DIR, 'state'))
const D1_PATHS = path.join(STATE_DIR, 'd1-paths.json')
const PORT = String(process.env.PORT || '8080')
const HOST = process.env.HOST || '0.0.0.0'
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const D1_DIR = path.join(STATE_DIR, 'v3', 'd1', 'miniflare-D1DatabaseObject')
const SEEDS = {
  home: path.join(DATA_DIR, 'home.sqlite'),
  sompitra: path.join(DATA_DIR, 'sompitra.sqlite'),
}

function log(message) {
  console.log(`[home] ${message}`)
}
function fail(message) {
  console.error(`[home] ${message}`)
  process.exit(1)
}

function wranglerEnv() {
  return { ...process.env, DATA_DIR, WRANGLER_SEND_METRICS: 'false' }
}

function runWrangler(args) {
  const res = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT,
    env: wranglerEnv(),
    encoding: 'utf8',
  })
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim().split('\n').slice(-6).join('\n')
    throw new Error(`wrangler ${args.join(' ')} failed\n${detail}`)
  }
  return res.stdout || ''
}

/**
 * Miniflare names a D1 file after a hash of the database identity, not the
 * binding, and that name is an implementation detail. Ask it in a throwaway
 * directory rather than hardcoding a hash that a Wrangler upgrade could move.
 */
function d1FileName(binding) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'home-d1-'))
  try {
    runWrangler(['d1', 'execute', binding, '--local', '--persist-to', tmp, '--command', 'SELECT 1'])
    const dir = path.join(tmp, 'v3', 'd1', 'miniflare-D1DatabaseObject')
    const file = fs.readdirSync(dir).find((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite')
    if (!file) throw new Error(`no local D1 file was created for ${binding}`)
    return file
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/** Fold a WAL back into the main file before it becomes the live copy. */
function checkpoint(file) {
  const db = new Database(file)
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
}

function migrate() {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'server', 'migrate.mjs')], {
    cwd: ROOT,
    env: wranglerEnv(),
    stdio: 'inherit',
  })
  if (res.status !== 0) fail('schema migration failed — see the message above')
}

function kindOf(file) {
  try {
    const stat = fs.lstatSync(file)
    return stat.isSymbolicLink() ? 'link' : stat.isFile() ? 'file' : 'other'
  } catch {
    return 'missing'
  }
}

ensureDataDir()
fs.mkdirSync(D1_DIR, { recursive: true })

// ── live files + the two friendly links ─────────────────────────
let names
try {
  names = { home: d1FileName('HOME_DB'), sompitra: d1FileName('DB') }
} catch (err) {
  fail(`could not resolve the local D1 files: ${err.message}`)
}
const live = {
  home: path.join(D1_DIR, names.home),
  sompitra: path.join(D1_DIR, names.sompitra),
}

// Adopt the Node build's real files once. Checkpoint them first: the old
// server left WAL mode on, and a clean stop may still have frames in the -wal.
for (const key of ['home', 'sompitra']) {
  if (!fs.existsSync(live[key]) && kindOf(SEEDS[key]) === 'file') {
    checkpoint(SEEDS[key])
    fs.copyFileSync(SEEDS[key], live[key])
    log(`adopted ${SEEDS[key]} → ${live[key]}`)
  }
}
// A fresh directory has neither live file, so the migrator builds the seeds
// and they are copied in below. This runs BEFORE the path map exists, so it
// writes the friendly files rather than an empty live database.
if (!fs.existsSync(live.home) || !fs.existsSync(live.sompitra)) {
  migrate()
  for (const key of ['home', 'sompitra']) {
    if (fs.existsSync(live[key])) continue
    checkpoint(SEEDS[key])
    fs.copyFileSync(SEEDS[key], live[key])
  }
}

// From here on every Node tool opens the live file, not the link. The map is
// RELATIVE to DATA_DIR so it resolves both inside the container (/data) and on
// the host (./data) through the bind mount.
fs.writeFileSync(
  D1_PATHS,
  JSON.stringify(
    {
      home: path.relative(DATA_DIR, live.home),
      sompitra: path.relative(DATA_DIR, live.sompitra),
    },
    null,
    2
  ) + '\n'
)

for (const key of ['home', 'sompitra']) {
  const kind = kindOf(SEEDS[key])
  if (kind === 'file') fs.rmSync(SEEDS[key])
  // A RELATIVE link: /data is /data only inside the container, so an absolute
  // target dangles the moment somebody looks at data/ from the host (and a
  // backup with `cp -L` would fail). Through the bind mount both spellings are
  // the same file.
  const target = path.relative(path.dirname(SEEDS[key]), live[key])
  let current = null
  if (kind === 'link') {
    try {
      current = fs.readlinkSync(SEEDS[key])
    } catch {
      // unreadable link — re-pointed below
    }
  }
  if (current !== target) {
    if (kind === 'link' || kind === 'other') fs.rmSync(SEEDS[key], { force: true })
    fs.symlinkSync(target, SEEDS[key])
  }
  // Leftovers beside the link belong to the old real file; SQLite uses the
  // live file's own sidecars now.
  for (const suffix of ['-wal', '-shm']) fs.rmSync(SEEDS[key] + suffix, { force: true })
}

// Through the map: applies whatever a module is missing (home, WAY, Sompitra,
// Laoka) so an older volume is upgraded on boot.
migrate()
log(`live data: ${live.home} · ${live.sompitra}`)

// ── secrets (same files the Node build used) ────────────────────
const pepper = (process.env.AUTH_PEPPER || '').trim() || loadSecret('AUTH_PEPPER', { min: 16 })
const session = (process.env.SESSION_SECRET || '').trim() || loadSecret('SESSION_SECRET', { min: 16 })
const vars = []
for (const [name, value] of [
  ['AUTH_PEPPER', pepper],
  ['SESSION_SECRET', session],
  ['PBKDF2_ITERATIONS', (process.env.PBKDF2_ITERATIONS || '').trim()],
  ['NTFY_URL', (process.env.NTFY_URL || '').trim()],
  ['NTFY_TOKEN', (process.env.NTFY_TOKEN || '').trim()],
]) {
  if (value) vars.push('--var', `${name}:${value}`)
}

// ── the Worker ──────────────────────────────────────────────────
log(`starting the Worker on http://${HOST}:${PORT} — Sompitra, W.A.Y, Laoka, Chat`)
const child = spawn(
  process.execPath,
  [WRANGLER, 'dev', '--ip', HOST, '--port', PORT, '--persist-to', STATE_DIR, '--test-scheduled', ...vars],
  { cwd: ROOT, env: wranglerEnv(), stdio: 'inherit' }
)

// `--test-scheduled` exposes the scheduled handler as a route. The Worker's
// own cron trigger does not fire in local mode, so the container keeps the
// 21:00 UTC day boundary itself (WAY's midnight, UTC+3).
let timer = null
function scheduleDaily() {
  if (process.env.DISABLE_CRON === '1') return
  const now = new Date()
  const next = new Date(now)
  next.setUTCHours(21, 0, 0, 0)
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1)
  timer = setTimeout(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/__scheduled?cron=0+21+*+*+*`)
      log(`daily flush: ${res.status}`)
    } catch (err) {
      log(`daily flush failed: ${err.message}`)
    }
    scheduleDaily()
  }, next - now)
  if (typeof timer.unref === 'function') timer.unref()
}

async function waitForServer() {
  for (let i = 0; i < 360; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/login`)
      if (res.ok) return true
    } catch {
      // still bundling / booting
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}
waitForServer().then((up) => {
  if (up) scheduleDaily()
  else log('the Worker did not answer /login — the container health check will report it')
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (timer) clearTimeout(timer)
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  })
}
child.on('error', (err) => fail(`could not start wrangler: ${err.message}`))
child.on('exit', (code, signal) => {
  if (timer) clearTimeout(timer)
  process.exit(code ?? (signal ? 1 : 0))
})
