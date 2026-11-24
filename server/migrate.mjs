// ─── Schema bootstrap ───────────────────────────────────────────
// `migrations-home/` and `migrations-sompitra/` are already the source of
// truth for the Cloudflare build, so the container reuses them verbatim.
//
// Two cases have to be told apart:
//
//   * a FRESH file — apply every migration, in filename order, and record it
//     in `schema_migrations`;
//   * an IMPORTED D1 dump — the schema is already there, so the files are
//     recorded as applied and NOT run. Running `0008_admin.sql` would re-grant
//     maxx admin on every boot, and `0003_enhancements.sql` would abort on an
//     ALTER TABLE whose column already exists.
//
// The sentinel is what separates "this file is a Sompitra database" from "this
// file is a Home database": both schemas have `users` and `sessions`.

import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { ensureDataDir, HOME_FILE, SOMPITRA_FILE } from './config.mjs'

const ROOT = process.cwd()
const HOME_MIGRATIONS = path.join(ROOT, 'migrations-home')
const SOMPITRA_MIGRATIONS = path.join(ROOT, 'migrations-sompitra')
// WAY's schema lives in the SAME database as the central identity (production
// merged them on 2026-10-06), so these files are applied to home.sqlite, not
// to a third file. 0000_baseline.sql must run first: 0001 assumes the baseline
// tables already exist.
const WAY_MIGRATIONS = path.join(ROOT, 'migrations-way')
const WAY_REPAIR = path.join(ROOT, 'scripts', 'repair-way-messages-fk.sql')

/** Split a migration file into statements, respecting quotes and comments. */
export function splitSql(sql) {
  const out = []
  let cur = ''
  let quote = null
  let i = 0

  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]

    if (quote) {
      cur += ch
      if (ch === quote) {
        if (next === quote) {
          cur += next
          i += 2
          continue
        }
        quote = null
      }
      i += 1
      continue
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      cur += ch
      i += 1
      continue
    }
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (ch === ';') {
      if (cur.trim()) out.push(cur.trim() + ';')
      cur = ''
      i += 1
      continue
    }
    cur += ch
    i += 1
  }

  if (cur.trim()) out.push(cur.trim())
  return out
}

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name)
}

function ensureLedger(db) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (' +
      'name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)'
  )
}

/**
 * Apply `dir` to `db`, or record it as already present.
 *
 * @param {Database} db
 * @param {string} dir
 * @param {{ sentinel: string, label: string, quiet?: boolean }} opts
 */
export function migrateDatabase(db, dir, { sentinel, reject, label, quiet = false }) {
  const existing = tableNames(db).filter((t) => t !== 'schema_migrations')
  ensureLedger(db)

  if (!fs.existsSync(dir)) {
    throw new Error(`${label}: migrations directory not found at ${dir}`)
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  const imported = existing.includes(sentinel)

  // A database belonging to the OTHER schema is a wrong --db, not something to
  // migrate. Both schemas have `users`/`sessions`, so this is the check that
  // catches a swap before any statement touches it.
  if (!imported && reject && existing.includes(reject)) {
    throw new Error(
      `${label}: this looks like the wrong database (it has "${reject}"). ` +
      `Point --db at the other file, or use a fresh DATA_DIR.`
    )
  }

  if (imported) {
    const at = new Date().toISOString()
    for (const file of files) {
      db.prepare('INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(file, at)
    }
    if (!quiet) console.log(`[home] ${label}: imported schema detected, migrations recorded (${files.length})`)
    return { applied: [], stamped: files.length, imported: true }
  }

  const applied = []
  const alterAdd = /^\s*ALTER\s+TABLE\s+["`[]?([A-Za-z0-9_]+)["`\]]?\s+ADD\s+(?:COLUMN\s+)?["`[]?([A-Za-z0-9_]+)/i
  const columnExists = (table, column) =>
    db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ? LIMIT 1').get(table, column) != null

  for (const file of files) {
    const already = db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(file)
    if (already) continue

    const sql = fs.readFileSync(path.join(dir, file), 'utf8')
    for (const statement of splitSql(sql)) {
      // A half-applied database (or a dump that already carries a column) is
      // allowed to resume: `ALTER TABLE ... ADD COLUMN` is skipped when the
      // column is already there, exactly like the wrangler migrator does.
      const alter = alterAdd.exec(statement)
      if (alter && columnExists(alter[1], alter[2])) continue
      try {
        db.exec(statement)
      } catch (err) {
        throw new Error(`${label}/${file}: ${err.message}\n${statement.slice(0, 240)}`)
      }
    }
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
      .run(file, new Date().toISOString())
    applied.push(file)
    if (!quiet) console.log(`[home] ${label}: applied ${file}`)
  }

  if (applied.length === 0 && !quiet) {
    console.log(`[home] ${label}: up to date`)
  }
  return { applied, stamped: 0, imported: false }
}

export function openRaw(file) {
  ensureDataDir()
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  return db
}

function tableHasColumn(db, table, column) {
  if (!tableNames(db).includes(table)) return false
  return db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ? LIMIT 1').get(table, column) != null
}

/**
 * The imported-schema path records every migration as applied without running
 * it. That is right for a complete production dump, but it cannot repair a
 * dump from before a column existed. These are the columns this container
 * WRITES, so they are checked (and added) explicitly.
 */
function ensureWayColumns(db) {
  const add = (table, column, declaration) => {
    if (tableHasColumn(db, table, column)) return
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`)
    } catch {
      // The table itself is absent; the caller will fail later with a schema
      // error that names it, which is clearer than swallowing this one.
    }
  }

  add('way_users', 'follow_zoom', 'INTEGER NOT NULL DEFAULT 16')
  add('way_users', 'home_fence', 'TEXT')
  add('way_users', 'ntfy_topic', 'TEXT')
  add('way_users', 'quiet_start', 'INTEGER NOT NULL DEFAULT 22')
  add('way_users', 'quiet_end', 'INTEGER NOT NULL DEFAULT 6')

  add('gps_pings', 'leg_id', 'INTEGER')
  add('gps_pings', 'sync_id', 'TEXT')

  add('messages', 'device_id', 'TEXT')
  add('messages', 'sync_id', 'TEXT')
  add('messages', 'reply_to_id', 'TEXT')
  add('messages', 'reply_to_sender', 'TEXT')
  add('messages', 'reply_to_snippet', 'TEXT')

  const tables = tableNames(db)
  if (tables.includes('gps_pings')) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_pings_device_ts ON gps_pings(device_id, timestamp)')
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_pings_sync_id ON gps_pings(sync_id)')
  }
  if (tables.includes('messages')) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at)')
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_sync_id ON messages(sync_id)')
  }
}

/** First sign-in links live in `invites` (migrations-home/0007). An IMPORTED
 *  dump has every migration stamped as applied WITHOUT running it, so a
 *  schema from before that table stays usable by creating it here — the same
 *  reason ensureWayColumns exists. Idempotent. */
function ensureHomeInvites(db) {
  if (tableNames(db).includes('invites')) return
  const file = path.join(HOME_MIGRATIONS, '0007_invites.sql')
  if (!fs.existsSync(file)) return
  try {
    db.exec(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    console.warn(`[home] could not create the invites table: ${err.message}`)
  }
}

/** 0002_settings.sql drops `devices`, but `messages.device_id` still references
 *  it — and D1/SQLite resolves the FK parent at write time, so without the
 *  repair EVERY message insert fails (AGENTS.md rule 19). Idempotent. */
function repairWayMessagesFk(db) {
  if (tableNames(db).includes('devices')) return
  if (!fs.existsSync(WAY_REPAIR)) {
    console.warn('[home] way: devices is missing and the repair SQL was not found')
    return
  }
  try {
    db.exec(fs.readFileSync(WAY_REPAIR, 'utf8'))
  } catch (err) {
    console.warn(`[home] way: could not repair the messages FK parent: ${err.message}`)
  }
}

export function migrateAll({ quiet = false } = {}) {
  const home = openRaw(HOME_FILE)
  const sompitra = openRaw(SOMPITRA_FILE)
  try {
    const homeResult = migrateDatabase(home, HOME_MIGRATIONS, {
      sentinel: 'home_settings',
      reject: 'transactions',
      label: 'home',
      quiet,
    })
    // WAY shares home.sqlite. It is migrated after the identity tables so its
    // `way_users` / `gps_pings` sit beside them, exactly as production has it.
    const wayResult = migrateDatabase(home, WAY_MIGRATIONS, {
      sentinel: 'gps_pings',
      reject: 'transactions',
      label: 'way',
      quiet,
    })
    ensureWayColumns(home)
    ensureHomeInvites(home)
    repairWayMessagesFk(home)
    const sompitraResult = migrateDatabase(sompitra, SOMPITRA_MIGRATIONS, {
      sentinel: 'transactions',
      reject: 'home_settings',
      label: 'sompitra',
      quiet,
    })
    return { home: homeResult, way: wayResult, sompitra: sompitraResult }
  } finally {
    home.close()
    sompitra.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = migrateAll()
  console.log(
    `[home] done — home: ${result.home.applied.length} applied, ` +
    `way: ${result.way.applied.length} applied, ` +
    `sompitra: ${result.sompitra.applied.length} applied`
  )
}
