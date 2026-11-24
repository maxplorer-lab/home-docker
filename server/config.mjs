// ─── Container configuration ────────────────────────────────────
// Two SQLite files, matching the two databases the Cloudflare build uses:
//
//   home.sqlite      HOME_DB + WAY_DB   (central identity, WAY users, the
//                                        chat/WAY flush targets)
//   sompitra.sqlite  DB + LAOKA_DB      (Sompitra finance, medications,
//                                        Laoka)
//
// Keeping them separate is not cosmetic: both schemas define `users` and
// `sessions`, so one file would collide. It also means each Cloudflare D1
// export drops straight into its own file.
//
// The files workerd actually opens live under `data/state/` and carry a hashed
// name; the friendly paths above are SYMLINKS for people and backups. Every
// Node tool therefore opens the path in `data/state/d1-paths.json` (written by
// server/worker-entry.mjs, relative to DATA_DIR) rather than the link: SQLite
// derives its -wal/-shm
// names from the path it was given, so opening the link would give one
// database two WAL sidecars and two uncoordinated writers.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const ROOT = process.cwd()
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'))

function liveDatabase(fallback, key) {
  try {
    const map = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'state', 'd1-paths.json'), 'utf8'))
    const target = map && map[key]
    // The map is relative to DATA_DIR; an older absolute entry still resolves.
    const resolved = typeof target === 'string' ? path.resolve(DATA_DIR, target) : null
    if (resolved && fs.existsSync(resolved)) return resolved
  } catch {
    // No live mapping yet (a fresh install, or the Node-only build).
  }
  return fallback
}

export const HOME_FILE = liveDatabase(path.join(DATA_DIR, 'home.sqlite'), 'home')
export const SOMPITRA_FILE = liveDatabase(path.join(DATA_DIR, 'sompitra.sqlite'), 'sompitra')

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

/**
 * A secret from the environment, or one generated once and kept in DATA_DIR.
 *
 * Persisted rather than per-boot so sessions survive a restart. For a
 * migration from Cloudflare, AUTH_PEPPER must be the PRODUCTION pepper —
 * otherwise every imported password hash fails to verify. Set it in the
 * environment; the generated fallback only exists so a fresh container can
 * bootstrap an account.
 */
export function loadSecret(name, { min = 16, file } = {}) {
  const fromEnv = (process.env[name] || '').trim()
  if (fromEnv.length >= min) return fromEnv

  const target = file || path.join(DATA_DIR, name.toLowerCase())
  try {
    const saved = fs.readFileSync(target, 'utf8').trim()
    if (saved.length >= min) return saved
  } catch {
    // No saved secret yet.
  }

  const value = crypto.randomBytes(32).toString('base64url')
  fs.writeFileSync(target, value + '\n', { mode: 0o600 })
  return value
}

export function alertSecretFallback(name) {
  if ((process.env[name] || '').trim().length >= 16) return
  // A saved secret is not a fallback: it is the value the app has been using,
  // and warning about it every time a tool runs is just noise (and wrong).
  try {
    if (fs.readFileSync(path.join(DATA_DIR, name.toLowerCase()), 'utf8').trim().length >= 16) return
  } catch {
    // no saved value either
  }
  console.warn(
    `[home] ${name} was not set — using a generated secret from ${DATA_DIR}.\n` +
    `[home] Imported passwords will NOT verify unless ${name} matches the one ` +
    `the Cloudflare deployment used.`
  )
}
