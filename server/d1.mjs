// ─── D1 over better-sqlite3 ─────────────────────────────────────
// The Sompitra routes are written against Cloudflare's D1 API
// (`prepare().bind().first()/all()/run()`, `batch`, `exec`). Implementing that
// small surface over a real SQLite file means the finance screens run
// UNCHANGED — same SQL, same pages — with none of D1's daily row limits.
//
// The one semantic difference that matters is placeholders. D1 code uses
// `?1`, `?2`, … freely (and repeats an index), while better-sqlite3 binds
// positional values only to anonymous `?`. So every statement is rewritten to
// NAMED parameters (`?1` → `@p1`, bare `?` → `@p<n>`), which also makes a
// repeated index bind one value, exactly as D1 does.

const CACHE = new WeakMap()

/**
 * Rewrite a statement's placeholders to named ones.
 * Returns `{ sql, count }` where `count` is the highest parameter index.
 */
export function rewritePlaceholders(source) {
  let maxNumbered = 0
  let anonymous = 0
  const parts = [] // literal strings and { index } markers
  let literal = ''
  let i = 0
  let quote = null

  const flush = () => {
    if (literal) {
      parts.push(literal)
      literal = ''
    }
  }

  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]

    if (quote) {
      literal += ch
      if (quote === ']' && ch === ']') {
        quote = null
      } else if (quote !== ']' && ch === quote) {
        if (next === quote) {
          literal += next
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
      literal += ch
      i += 1
      continue
    }
    if (ch === '[') {
      quote = ']'
      literal += ch
      i += 1
      continue
    }
    if (ch === '-' && next === '-') {
      while (i < source.length && source[i] !== '\n') {
        literal += source[i]
        i += 1
      }
      continue
    }
    if (ch === '/' && next === '*') {
      literal += '/*'
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        literal += source[i]
        i += 1
      }
      if (i < source.length) {
        literal += '*/'
        i += 2
      }
      continue
    }

    if (ch === '?') {
      let j = i + 1
      let digits = ''
      while (j < source.length && source[j] >= '0' && source[j] <= '9') {
        digits += source[j]
        j += 1
      }
      flush()
      if (digits) {
        const index = Number(digits)
        maxNumbered = Math.max(maxNumbered, index)
        parts.push({ index })
      } else {
        anonymous += 1
        parts.push({ anonymous: true })
      }
      i = j
      continue
    }

    literal += ch
    i += 1
  }
  flush()

  let bare = maxNumbered
  let out = ''
  for (const part of parts) {
    if (typeof part === 'string') {
      out += part
    } else if (part.index !== undefined) {
      out += `@p${part.index}`
    } else {
      bare += 1
      out += `@p${bare}`
    }
  }
  return { sql: out, count: bare }
}

function normalize(value) {
  if (value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.toISOString()
  return value
}

function meta(started, changes = 0, lastRowId = 0) {
  return {
    duration: Math.max(0, Date.now() - started),
    changes,
    last_row_id: Number(lastRowId) || 0,
    rows_read: 0,
    rows_written: changes,
    changed_db: changes > 0,
  }
}

class D1Statement {
  constructor(db, source, params = []) {
    this.db = db
    this.source = source
    this.params = params
  }

  bind(...params) {
    return new D1Statement(this.db, this.source, params.map(normalize))
  }

  _statement() {
    let bySql = CACHE.get(this.db)
    if (!bySql) {
      bySql = new Map()
      CACHE.set(this.db, bySql)
    }
    let entry = bySql.get(this.source)
    if (!entry) {
      entry = rewritePlaceholders(this.source)
      bySql.set(this.source, entry)
    }
    const prepared = this.db.prepare(entry.sql)
    const args = []
    for (let n = 1; n <= entry.count; n += 1) args.push(this.params[n - 1])
    return { prepared, args: entry.count > 0 ? [Object.fromEntries(args.map((v, i) => [`p${i + 1}`, v]))] : [] }
  }

  _runSync() {
    const { prepared, args } = this._statement()
    const started = Date.now()
    const info = prepared.run(...args)
    return {
      success: true,
      results: [],
      meta: meta(started, info.changes, info.lastInsertRowid),
    }
  }

  _allSync() {
    const { prepared, args } = this._statement()
    const started = Date.now()
    return {
      success: true,
      results: prepared.all(...args),
      meta: meta(started),
    }
  }

  async first(column) {
    const { prepared, args } = this._statement()
    const row = prepared.get(...args)
    if (!row) return null
    if (column !== undefined && column !== null) return row[column] ?? null
    return row
  }

  async all() {
    return this._allSync()
  }

  async run() {
    return this._runSync()
  }

  async raw() {
    const { prepared, args } = this._statement()
    const rows = prepared.raw().all(...args)
    return rows
  }
}

export class D1 {
  constructor(raw) {
    this.raw = raw
  }

  prepare(sql) {
    return new D1Statement(this.raw, String(sql))
  }

  async batch(statements) {
    if (!Array.isArray(statements)) throw new Error('D1.batch expects an array of statements')
    const run = this.raw.transaction((list) =>
      list.map((statement) => (statement._statement().prepared.reader ? statement._allSync() : statement._runSync()))
    )
    return run(statements)
  }

  async exec(sql) {
    const started = Date.now()
    this.raw.exec(String(sql))
    return { count: 0, duration: Math.max(0, Date.now() - started) }
  }

  async dump() {
    throw new Error('dump() is not implemented — copy the .sqlite file instead')
  }
}

export function createD1(raw) {
  return new D1(raw)
}
