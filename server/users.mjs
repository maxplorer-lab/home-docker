#!/usr/bin/env node
// ─── Household accounts ─────────────────────────────────────────
// A CSV or SQL import carries DATA, not a login. This command creates the
// person everywhere the app looks for one, with ONE password:
//
//   home.sqlite.users       the central login — peppered PBKDF2, the exact
//                           scheme /login verifies
//   sompitra.sqlite.users   the Sompitra row, matched by username (so the
//                           imported history keeps its attribution); --admin
//                           also sets its is_admin fallback
//   home.sqlite.way_users   W.A.Y's own "salt:hash" PBKDF2-100k format, which
//                           is ALSO the μlogger phone credential
//
// The hashing is imported from src/identity.ts rather than re-implemented, so
// the formats cannot drift from the login (rule 5: W.A.Y's format is
// load-bearing for the phones).
//
// Run it with tsx, like the server (it imports TypeScript):
//
//   tsx server/users.mjs set maxx --name MaxX --admin
//   tsx server/users.mjs set niri --name Niri
//   tsx server/users.mjs set maxx --invite      # they choose their own
//   tsx server/users.mjs list
//
// Without --password a strong one is generated and printed once. Running `set`
// again resets that person's password in all three places, without touching
// their id. With --invite the password is not handed out at all: the command
// prints a one-time link, the person opens /claim and chooses it. On an account
// that already has a password, --invite leaves that password alone.

import crypto from 'node:crypto'
import { createEnv } from './env.mjs'
import { migrateAll } from './migrate.mjs'
import {
  createHomeUser,
  ensureModuleAccounts,
  findHomeUserByName,
  setHomePassword,
  validPassword,
  validUsername,
  wayHashPassword,
  createInvite,
} from '../src/identity'

const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function fail(message) {
  console.error(`[users] ${message}`)
  process.exit(1)
}

function usage() {
  console.log(
    'usage:\n' +
    '  tsx server/users.mjs list\n' +
    '  tsx server/users.mjs set <username> [--password <pw>] [--name <display>] [--admin|--member] [--invite]\n' +
    '\n' +
    'Without --password a strong one is generated and printed once.\n' +
    'With --invite, print a one-time /claim link instead: the person chooses.'
  )
  process.exit(2)
}

function parseArgs(argv) {
  const flags = {}
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=')
      if (inline !== undefined) flags[key] = inline
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[key] = argv[++i]
      else flags[key] = true
    } else {
      rest.push(arg)
    }
  }
  return { flags, rest }
}

function makePassword(length = 16) {
  const bytes = crypto.randomBytes(length)
  let out = ''
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length]
  return out
}

async function listUsers(env) {
  const res = await env.HOME_DB.prepare(
    'SELECT id, username, display_name, role, is_active FROM users ORDER BY username'
  ).all()
  const rows = res.results || []
  if (rows.length === 0) {
    console.log('[users] no central accounts yet')
    return
  }

  console.log('[users] username         role    active  sompitra  way      sign-in')
  for (const row of rows) {
    const sompitra = await env.DB
      .prepare('SELECT 1 AS ok FROM users WHERE lower(username) = lower(?)')
      .bind(row.username)
      .first()
    const way = await env.WAY_DB
      .prepare('SELECT 1 AS ok FROM way_users WHERE lower(username) = lower(?)')
      .bind(row.username)
      .first()
    let pending = null
    try {
      pending = await env.HOME_DB
        .prepare("SELECT 1 AS ok FROM invites WHERE user_id = ? AND used_at IS NULL AND expires_at > datetime('now') LIMIT 1")
        .bind(row.id)
        .first()
    } catch {
      // A database imported from before migrations-home/0007.
    }
    console.log(
      `[users] ${String(row.username).padEnd(16)} ${String(row.role).padEnd(7)} ` +
      `${row.is_active ? 'yes   ' : 'no    '} ${sompitra ? 'yes      ' : 'missing  '} ${(way ? 'yes' : 'missing').padEnd(8)} ${pending ? 'link' : 'set'}`
    )
  }
}

async function setUser(env, username, flags) {
  if (!validUsername(username)) {
    fail('usernames are 3-24 characters: letters, numbers, dot, dash or underscore')
  }

  const provided = typeof flags.password === 'string' ? flags.password : null
  if (provided && !validPassword(provided)) fail('the password must be 8-200 characters')
  const invite = Boolean(flags.invite)
  const display = typeof flags.name === 'string' ? flags.name.trim() : null
  const role = flags.admin ? 'admin' : flags.member ? 'member' : null

  let user = await findHomeUserByName(env.HOME_DB, username)
  let created = false
  // A NEW account needs SOME credential so its module rows can be created; with
  // --invite that one is random and never printed, and the person replaces it
  // when they open the link. An EXISTING account is left alone by --invite —
  // re-minting an expired link must not sign somebody out.
  const password = provided || makePassword()
  const generated = !provided && !invite

  if (!user) {
    const made = await createHomeUser(env, {
      username,
      password,
      displayName: display || username,
      role: role === 'admin' ? 'admin' : 'member',
    })
    if (!made.ok) fail(made.error)
    created = true
    user = await findHomeUserByName(env.HOME_DB, username)
  } else {
    if (provided) {
      const set = await setHomePassword(env, user.id, password)
      if (!set.ok) fail(set.error || 'could not set the password')
    }
    if (display || role) {
      await env.HOME_DB
        .prepare('UPDATE users SET display_name = COALESCE(?, display_name), role = COALESCE(?, role) WHERE id = ?')
        .bind(display, role, user.id)
        .run()
    }
    user = await findHomeUserByName(env.HOME_DB, username)
  }
  if (!user) fail('the central account disappeared while it was being written')
  const passwordChanged = Boolean(provided) || created

  // The app's own provisioner: it creates the Sompitra and WAY rows a missing
  // person needs, with this password hashed into each module's own format.
  // The password is a PARAMETER (rule 38), so this cannot leak between people.
  await ensureModuleAccounts(env, user, password)

  const effectiveRole = role || user.role
  const sompitra = await env.DB
    .prepare('SELECT id FROM users WHERE lower(username) = lower(?)')
    .bind(user.username)
    .first()
  const way = await env.WAY_DB
    .prepare('SELECT id FROM way_users WHERE lower(username) = lower(?)')
    .bind(user.username)
    .first()

  if (sompitra) {
    try {
      await env.DB
        .prepare('UPDATE users SET display_name = ?, is_admin = ? WHERE id = ?')
        .bind(user.display_name || user.username, effectiveRole === 'admin' ? 1 : 0, sompitra.id)
        .run()
    } catch (err) {
      console.warn(`[users] could not set the Sompitra row's display name/is_admin: ${err.message || err}`)
    }
  }

  if (way) {
    // The phone's password is the SAME password, in W.A.Y's own format. A
    // re-run is how a phone credential is reset — but only when this command
    // actually chose a password, or --invite would silently change a phone's
    // credential while the person's browser password stayed the old one.
    if (passwordChanged) {
      await env.WAY_DB
        .prepare('UPDATE way_users SET password_hash = ?, role = ? WHERE id = ?')
        .bind(await wayHashPassword(password), effectiveRole === 'admin' ? 'admin' : 'member', way.id)
        .run()
    }
  }

  let inviteToken = null
  if (invite) {
    try {
      inviteToken = await createInvite(env, user.id)
    } catch (err) {
      fail(
        `could not create the first sign-in link: ${err?.message || err}\n` +
        '  run: node server/migrate.mjs'
      )
    }
  }

  console.log(`[users] ${user.username} — ${effectiveRole}${created ? ' (created)' : ' (updated)'}`)
  console.log('[users]   central login: ready')
  console.log(
    `[users]   sompitra row: ${sompitra ? 'ready (imported history keeps its attribution)' : 'MISSING — check migrations-sompitra'}`
  )
  console.log(
    `[users]   phone (μlogger): ${way
      ? inviteToken ? 'ready — the password is set with the link' : passwordChanged ? 'ready, same password' : 'ready, password unchanged'
      : 'MISSING — check migrations-way'}`
  )
  if (generated) console.log(`[users]   password: ${password}`)
  if (inviteToken) {
    const base = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '')
    console.log('[users]   first sign-in link (one-time, 14 days):')
    console.log(`[users]     ${base}/claim?token=${inviteToken}`)
    if (!base) console.log('[users]   prefix that path with your site address (e.g. http://localhost:8080).')
  }

  if (!sompitra || !way) process.exitCode = 1
}

async function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2))

  // Bring a fresh data directory up to date first (a no-op when it already is),
  // so this works in the same one-command way the CSV importer does.
  migrateAll({ quiet: true })
  const { env, close } = createEnv()

  try {
    if (rest[0] === 'list') {
      await listUsers(env)
      return
    }
    if (rest[0] !== 'set' && rest[0] !== 'add') usage()
    const username = rest[1]
    if (!username) usage()
    await setUser(env, username, flags)
  } finally {
    close()
  }
}

main().catch((err) => {
  console.error(`[users] ${err?.stack || err}`)
  process.exit(1)
})
