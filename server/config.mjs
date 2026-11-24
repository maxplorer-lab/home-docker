// ─── Container configuration ────────────────────────────────────
// Two SQLite files, matching the two databases the Cloudflare build uses:
//
//   home.sqlite      HOME_DB + WAY_DB   (central identity. WAY is not mounted
//                                        in this build, but the binding stays
//                                        so provisioning code keeps working.)
//   sompitra.sqlite  DB + LAOKA_DB      (Sompitra finance + the medications
//                                        table; Laoka is not mounted.)
//
// Keeping them separate is not cosmetic: both schemas define `users` and
// `sessions`, so one file would collide. It also means each Cloudflare D1
// export drops straight into its own file.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const ROOT = process.cwd()
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'))
export const HOME_FILE = path.join(DATA_DIR, 'home.sqlite')
export const SOMPITRA_FILE = path.join(DATA_DIR, 'sompitra.sqlite')

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
  console.warn(
    `[home] ${name} was not set — using a generated secret from ${DATA_DIR}.\n` +
    `[home] Imported passwords will NOT verify unless ${name} matches the one ` +
    `the Cloudflare deployment used.`
  )
}
