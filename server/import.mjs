#!/usr/bin/env node
// ─── Data import ────────────────────────────────────────────────
// Two ways in, because the Cloudflare side can offer two kinds of export:
//
//   1. A D1 SQL dump — the SEAMLESS path. `wrangler d1 export` writes the whole
//      schema and every row; importing it means the container starts with the
//      household's exact data, passwords included (when AUTH_PEPPER matches).
//
//        node server/import.mjs sql ./sompitra.sql --db sompitra
//        node server/import.mjs sql ./home.sql    --db home
//
//   2. CSV — the fallback. One file per table (transactions.csv, customers.csv,
//      …), or a single transactions export with human-readable names instead of
//      ids. Category/account/user names are resolved (and created when absent).
//
//        node server/import.mjs csv ./exports/
//        node server/import.mjs csv ./transactions.csv --table transactions
//
// Both commands are meant to run BEFORE the container serves (or with it
// stopped). SQL import refuses a non-empty target unless --fresh is given;
// --fresh deletes the SQLite file first and is explicit for that reason.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import Database from 'better-sqlite3'
import { ensureDataDir, HOME_FILE, SOMPITRA_FILE } from './config.mjs'
import { migrateAll } from './migrate.mjs'

const UUID = () => crypto.randomUUID()

// ── arguments ───────────────────────────────────────────────────
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

const { flags, rest } = parseArgs(process.argv.slice(3))
const command = process.argv[2]

function fail(message) {
  console.error(`[import] ${message}`)
  process.exit(1)
}

function dbNameFrom(value) {
  if (value === 'home' || value === 'sompitra') return value
  fail(`--db must be "home" or "sompitra" (got ${JSON.stringify(value)})`)
}

function dbFileFor(name) {
  return name === 'home' ? HOME_FILE : SOMPITRA_FILE
}

function tableNames(raw) {
  return raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name)
}

function removeFile(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(file + suffix)
    } catch {
      // already gone
    }
  }
}

// ── SQL dump ────────────────────────────────────────────────────
function importSql(file, options) {
  if (!file || !fs.existsSync(file)) fail(`no such file: ${file}`)
  const name = options.db || (/sompitra/i.test(path.basename(file)) ? 'sompitra' : /home/i.test(path.basename(file)) ? 'home' : null)
  if (!name) fail('cannot tell which database this dump belongs to — pass --db home|sompitra')

  const target = dbFileFor(name)
  ensureDataDir()
  if (options.fresh) removeFile(target)

  const raw = new Database(target)
  raw.pragma('journal_mode = WAL')
  raw.pragma('busy_timeout = 5000')
  raw.pragma('foreign_keys = OFF')

  const before = tableNames(raw)
  if (before.length > 0 && !options.fresh) {
    raw.close()
    fail(
      `${target} already has ${before.length} tables. Refusing to import into it.\n` +
      `  Move the data directory aside, or pass --fresh to delete this file first.`
    )
  }

  const sql = fs.readFileSync(file, 'utf8')
  try {
    raw.exec(sql)
  } catch (err) {
    raw.close()
    fail(`SQL import failed: ${err.message}`)
  }

  raw.pragma('foreign_keys = ON')
  const violations = raw.prepare('PRAGMA foreign_key_check').all()
  const tables = tableNames(raw)
  let rows = 0
  for (const table of tables) {
    try {
      rows += raw.prepare(`SELECT COUNT(*) AS n FROM "${table.replace(/"/g, '""')}"`).get().n
    } catch {
      // virtual table
    }
  }
  raw.close()

  console.log(`[import] ${path.basename(file)} → ${target}`)
  console.log(`[import] ${tables.length} tables, ~${rows} rows`)
  if (violations.length) {
    console.warn(`[import] WARNING: ${violations.length} foreign-key violations (rows kept)`)
  }
  console.log('[import] start the container: the schema is detected and recorded, not re-run')
}

// ── CSV ─────────────────────────────────────────────────────────
export function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '')
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'))
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ','

  const rows = []
  let row = []
  let field = ''
  let quoted = false

  const pushRow = () => {
    row.push(field)
    field = ''
    if (row.length > 1 || (row[0] !== '' && row[0] !== undefined)) rows.push(row)
    row = []
  }

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      pushRow()
    } else if (ch !== '\r') {
      field += ch
    }
  }
  pushRow()
  return rows
}

function normalizeHeader(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function tableFromFilename(file) {
  let base = path.basename(file, path.extname(file)).toLowerCase()
  base = base.replace(/^\d+[-_\s]*/, '')
  base = base.replace(/^(sompitra|home)[-_\s]+/, '')
  base = base.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

  const aliases = {
    tx: 'transactions',
    txn: 'transactions',
    txns: 'transactions',
    transaction: 'transactions',
    income_account: 'income_accounts',
    account: 'income_accounts',
    accounts: 'income_accounts',
    category_group: 'category_groups',
    groups: 'category_groups',
    category: 'categories',
    customer: 'customers',
    contract: 'service_contracts',
    contracts: 'service_contracts',
    kine_contracts: 'service_contracts',
    tick: 'attendance_ticks',
    ticks: 'attendance_ticks',
    client_payment: 'client_payments',
    inventory: 'inventory_items',
    item: 'inventory_items',
    sale: 'sales_records',
    sales: 'sales_records',
    debt_account: 'debt_credit_accounts',
    debt_accounts: 'debt_credit_accounts',
    medication: 'medications',
    medicines: 'medications',
    users: 'users',
  }
  return aliases[base] || base
}

function numeric(value) {
  if (typeof value === 'number') return value
  let text = String(value ?? '').trim()
  if (!text) return 0
  text = text.replace(/[^\d.,-]/g, '')
  if (text.includes(',') && text.includes('.')) text = text.replace(/,/g, '')
  else if (text.includes(',')) text = text.replace(/,/g, '')
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : 0
}

function dateValue(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10)
  const dmy = text.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/)
  if (dmy) {
    const [, day, month, year] = dmy
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10)
}

function truthy(value) {
  return /^(1|true|yes|y|on)$/i.test(String(value ?? '').trim())
}

function pick(row, ...names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== '') return row[name]
  }
  return undefined
}

/** Name resolution for the transactions importer. Creates what is missing. */
function makeResolvers(raw, stats) {
  const groupByName = new Map()
  const categoryByName = new Map()
  const accountByName = new Map()
  const userByName = new Map()
  const fallbackUser = raw.prepare('SELECT id FROM users ORDER BY created_at LIMIT 1').get()

  const ensureUser = (value) => {
    const name = String(value ?? '').trim()
    if (!name) return fallbackUser?.id ?? null
    const key = name.toLowerCase()
    if (userByName.has(key)) return userByName.get(key)
    let row = raw
      .prepare('SELECT id FROM users WHERE lower(username) = lower(?) OR lower(display_name) = lower(?) LIMIT 1')
      .get(name, name)
    if (!row) {
      const id = UUID()
      raw.prepare('INSERT INTO users (id, username, display_name, pin_hash) VALUES (?, ?, ?, ?)')
        .run(id, name, name, 'IMPORTED')
      row = { id }
      stats.users += 1
    }
    userByName.set(key, row.id)
    return row.id
  }

  const ensureGroup = (value) => {
    const name = String(value ?? '').trim() || 'Imported'
    const key = name.toLowerCase()
    if (groupByName.has(key)) return groupByName.get(key)
    let row = raw.prepare('SELECT id FROM category_groups WHERE lower(name) = lower(?)').get(name)
    if (!row) {
      const id = UUID()
      const order = raw.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM category_groups').get().n
      raw.prepare('INSERT INTO category_groups (id, name, sort_order) VALUES (?, ?, ?)').run(id, name, order)
      row = { id }
      stats.groups += 1
    }
    groupByName.set(key, row.id)
    return row.id
  }

  const ensureCategory = (nameValue, groupValue) => {
    const name = String(nameValue ?? '').trim()
    if (!name) return null
    const groupName = String(groupValue ?? '').trim()
    const key = (groupName + '::' + name).toLowerCase()
    if (categoryByName.has(key)) return categoryByName.get(key)

    const groupId = ensureGroup(groupName)
    let row = raw
      .prepare('SELECT id FROM categories WHERE lower(name) = lower(?) AND group_id = ? LIMIT 1')
      .get(name, groupId)
    if (!row) {
      const id = UUID()
      const order = raw.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM categories WHERE group_id = ?').get(groupId).n
      raw.prepare('INSERT INTO categories (id, group_id, name, sort_order) VALUES (?, ?, ?, ?)')
        .run(id, groupId, name, order)
      row = { id }
      stats.categories += 1
    }
    categoryByName.set(key, row.id)
    return row.id
  }

  const ensureAccount = (nameValue, userId) => {
    const name = String(nameValue ?? '').trim()
    if (!name) return null
    const key = name.toLowerCase()
    if (accountByName.has(key)) return accountByName.get(key)
    let row = raw.prepare('SELECT id FROM income_accounts WHERE lower(name) = lower(?) LIMIT 1').get(name)
    if (!row) {
      const id = UUID()
      raw.prepare(
        'INSERT INTO income_accounts (id, user_id, name, is_protected) VALUES (?, ?, ?, 0)'
      ).run(id, userId || fallbackUser?.id || null, name)
      row = { id }
      stats.accounts += 1
    }
    accountByName.set(key, row.id)
    return row.id
  }

  return { ensureUser, ensureGroup, ensureCategory, ensureAccount }
}

function importTransactions(raw, header, rows, options) {
  const stats = { inserted: 0, skipped: 0, users: 0, groups: 0, categories: 0, accounts: 0 }
  const resolvers = makeResolvers(raw, stats)
  const record = (values) => {
    if (options.dryRun) {
      stats.inserted += 1
      return
    }
    raw.prepare(
      `INSERT OR REPLACE INTO transactions
        (id, date, amount, type, income_account_id, category_id, description, notes,
         added_by_user_id, is_recurring, is_envelope_transfer, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      values.id,
      values.date,
      values.amount,
      values.type,
      values.incomeAccountId,
      values.categoryId,
      values.description,
      values.notes,
      values.addedByUserId,
      values.isRecurring,
      values.isEnvelopeTransfer,
      values.createdAt,
    )
    stats.inserted += 1
  }

  const work = () => {
    for (const row of rows) {
      const dates = pick(row, 'date', 'transaction_date', 'day')
      const date = dateValue(dates)
      if (!date) {
        stats.skipped += 1
        continue
      }

      const rawType = String(pick(row, 'type', 'direction') ?? 'expense').trim().toLowerCase()
      const type = rawType === 'income' || rawType === 'in' || rawType === 'credit' ? 'income' : 'expense'
      const amount = numeric(pick(row, 'amount', 'total', 'value', 'price'))
      if (!amount) {
        stats.skipped += 1
        continue
      }

      const addedById = resolvers.ensureUser(pick(row, 'added_by', 'user', 'username', 'person', 'added_by_user'))
      const userId = pick(row, 'added_by_user_id')
        ? String(pick(row, 'added_by_user_id'))
        : addedById

      let categoryId = null
      let accountId = null

      if (type === 'income') {
        const direct = pick(row, 'income_account_id')
        accountId = direct
          ? String(direct)
          : resolvers.ensureAccount(pick(row, 'income_account', 'income_account_name', 'account', 'account_name'), userId)
      } else {
        const direct = pick(row, 'category_id')
        if (direct) {
          categoryId = String(direct)
        } else {
          let categoryName = pick(row, 'category', 'category_name', 'category_label')
          let groupName = pick(row, 'group', 'group_name', 'category_group')
          if (!groupName && typeof categoryName === 'string' && categoryName.includes(' / ')) {
            const parts = categoryName.split(' / ')
            groupName = parts[0]
            categoryName = parts.slice(1).join(' / ')
          }
          categoryId = resolvers.ensureCategory(categoryName, groupName)
        }
      }

      record({
        id: String(pick(row, 'id', 'transaction_id') || UUID()),
        date,
        amount,
        type,
        incomeAccountId: accountId,
        categoryId,
        description: pick(row, 'description', 'name', 'label') ?? null,
        notes: pick(row, 'notes', 'note', 'items', 'details') ?? null,
        addedByUserId: userId,
        isRecurring: truthy(pick(row, 'is_recurring', 'recurring')) ? 1 : 0,
        isEnvelopeTransfer: truthy(pick(row, 'is_envelope_transfer', 'envelope_transfer')) ? 1 : 0,
        createdAt: pick(row, 'created_at', 'created') || new Date().toISOString(),
      })
    }
  }

  if (options.dryRun) work()
  else raw.transaction(work)()

  return stats
}

function importTable(raw, table, header, rows, options) {
  const info = raw.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all()
  if (info.length === 0) {
    const available = tableNames(raw).join(', ')
    fail(`no table "${table}" — available tables: ${available}`)
  }

  const columns = new Map(info.map((c) => [c.name, c]))
  const mapped = header.map((name) => (columns.has(name) ? name : null))
  const used = mapped.filter(Boolean)
  if (used.length === 0) {
    fail(`none of the CSV headers match "${table}" (columns: ${[...columns.keys()].join(', ')})`)
  }

  const numericColumns = new Set(
    info.filter((c) => /INT|REAL|NUM|DOUBLE|FLOAT|DECIMAL/i.test(String(c.type || ''))).map((c) => c.name)
  )
  const valuesOf = (row) =>
    mapped.map((column, index) => {
      if (!column) return undefined
      const value = row[index]
      if (numericColumns.has(column) && String(value ?? '').trim() === '') return null
      return value === undefined ? null : value
    })

  let inserted = 0
  let skipped = 0
  const work = () => {
    for (const row of rows) {
      const values = valuesOf(row)
      if (values.every((v) => v === null || v === '' || v === undefined)) {
        skipped += 1
        continue
      }
      const insertColumns = used
      const payload = mapped
        .map((column, index) => (column ? values[index] : undefined))
        .filter((v) => v !== undefined)
      if (options.dryRun) {
        inserted += 1
        continue
      }
      const placeholders = insertColumns.map(() => '?').join(', ')
      raw.prepare(
        `INSERT OR REPLACE INTO "${table.replace(/"/g, '""')}" (${insertColumns.map((c) => `"${c}"`).join(', ')}) ` +
        `VALUES (${placeholders})`
      ).run(...payload)
      inserted += 1
    }
  }

  if (options.dryRun) work()
  else raw.transaction(work)()

  return { inserted, skipped, columns: used }
}

function importCsvFiles(files, options) {
  if (files.length === 0) fail('no CSV files found')

  // CSV import needs a schema to write into, so bring a fresh database up to
  // date first (a no-op when it already is).
  migrateAll({ quiet: true })

  const name = options.db || 'sompitra'
  const target = dbFileFor(name)
  const raw = new Database(target)
  raw.pragma('journal_mode = WAL')
  raw.pragma('busy_timeout = 5000')
  raw.pragma('foreign_keys = OFF')

  let total = 0
  let skipped = 0

  try {
    for (const file of files) {
      let table = options.table ? String(options.table) : tableFromFilename(file)
      const parsed = parseCsv(fs.readFileSync(file, 'utf8'))
      if (parsed.length === 0) {
        console.warn(`[import] ${path.basename(file)}: empty — skipped`)
        continue
      }
      const header = parsed.shift().map(normalizeHeader)
      const rows = parsed

      // A single unnamed export whose headers look like a ledger is a
      // transactions file, whatever it was called. This is what makes
      // `--table` optional for the common case (one CSV, exported by hand).
      if (!options.table) {
        const exists = raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
        const looksLikeLedger = header.includes('date') && (header.includes('amount') || header.includes('total'))
        if (!exists && looksLikeLedger) table = 'transactions'
      }

      if (table === 'transactions') {
        // Header names are the only handle a CSV row has; zip them into objects
        // before the resolver sees them (the generic table importer indexes by
        // position instead).
        const records = rows.map((row) => Object.fromEntries(header.map((h, i) => [h, row[i]])))
        const stats = importTransactions(raw, header, records, options)
        total += stats.inserted
        skipped += stats.skipped
        console.log(
          `[import] ${path.basename(file)} → transactions: ${stats.inserted} rows` +
          (stats.skipped ? `, ${stats.skipped} skipped (no date/amount)` : '') +
          (stats.categories ? `, ${stats.categories} categories created` : '') +
          (stats.groups ? `, ${stats.groups} groups created` : '') +
          (stats.accounts ? `, ${stats.accounts} accounts created` : '') +
          (stats.users ? `, ${stats.users} users created` : '')
        )
      } else {
        const result = importTable(raw, table, header, rows, options)
        total += result.inserted
        skipped += result.skipped
        console.log(`[import] ${path.basename(file)} → ${table}: ${result.inserted} rows` +
          (result.skipped ? `, ${result.skipped} empty skipped` : ''))
      }
    }

    raw.pragma('foreign_keys = ON')
    const violations = raw.prepare('PRAGMA foreign_key_check').all()
    if (violations.length) {
      console.warn(`[import] WARNING: ${violations.length} foreign-key violations (rows kept)`)
    }
  } finally {
    raw.close()
  }

  console.log(`[import] done: ${total} rows${skipped ? `, ${skipped} skipped` : ''}`)
  if (options.dryRun) console.log('[import] dry run — nothing was written')
}

// ── entry point ─────────────────────────────────────────────────
const input = rest[0]

if (command === 'sql') {
  importSql(input, flags)
} else if (command === 'csv') {
  if (!input) fail('usage: node server/import.mjs csv <file-or-directory> [--table name] [--db sompitra]')
  const candidates = fs.existsSync(input) && fs.statSync(input).isDirectory()
    ? fs.readdirSync(input).filter((f) => f.toLowerCase().endsWith('.csv')).sort().map((f) => path.join(input, f))
    : [input]
  importCsvFiles(candidates, flags)
} else {
  fail(
    'usage:\n' +
    '  node server/import.mjs sql <dump.sql> --db home|sompitra [--fresh]\n' +
    '  node server/import.mjs csv <file-or-directory> [--table name] [--dry-run]'
  )
}
