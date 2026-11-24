// ─── The app's bindings, backed by two SQLite files ─────────────
// The route code asks for HOME_DB / WAY_DB / DB / LAOKA_DB by name, exactly as
// it does on Cloudflare. Here the pairs point at the same FILE:
//
//   HOME_DB + WAY_DB   → home.sqlite
//   DB      + LAOKA_DB → sompitra.sqlite
//
// That mirrors the merged production layout (two physical databases behind
// four binding names) and keeps `users`/`sessions` from colliding.
//
// FLEET_DO is deliberately absent: the chat/tracking Durable Object is not
// part of this build, and `postSystemChat` already treats a missing binding as
// "there is no chat to post into". Notifications still work through ntfy.

import { ensureDataDir, HOME_FILE, SOMPITRA_FILE, loadSecret, alertSecretFallback } from './config.mjs'
import { openDatabase } from './db.mjs'

export function createEnv() {
  ensureDataDir()
  alertSecretFallback('AUTH_PEPPER')
  alertSecretFallback('SESSION_SECRET')

  const home = openDatabase(HOME_FILE)
  const sompitra = openDatabase(SOMPITRA_FILE)

  const env = {
    HOME_DB: home.d1,
    WAY_DB: home.d1,
    DB: sompitra.d1,
    LAOKA_DB: sompitra.d1,
    FLEET_DO: undefined,
    LOBBY: undefined,
    ASSETS: undefined,

    APP_NAME: 'Home',
    AUTH_PEPPER: loadSecret('AUTH_PEPPER', { min: 16 }),
    SESSION_SECRET: loadSecret('SESSION_SECRET', { min: 16 }),
    SETUP_TOKEN: (process.env.SETUP_TOKEN || '').trim() || undefined,
    NTFY_URL: (process.env.NTFY_URL || '').trim() || undefined,
    NTFY_TOKEN: (process.env.NTFY_TOKEN || '').trim() || undefined,
    PBKDF2_ITERATIONS: (process.env.PBKDF2_ITERATIONS || '5000').trim(),
  }

  return {
    env,
    close() {
      home.raw.close()
      sompitra.raw.close()
    },
  }
}
