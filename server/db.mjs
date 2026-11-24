import Database from 'better-sqlite3'
import { createD1 } from './d1.mjs'

/** Open a SQLite file with the pragmas the app expects. */
export function openDatabase(file) {
  const raw = new Database(file)
  raw.pragma('journal_mode = WAL')
  raw.pragma('busy_timeout = 5000')
  raw.pragma('foreign_keys = ON')
  return { raw, d1: createD1(raw) }
}
