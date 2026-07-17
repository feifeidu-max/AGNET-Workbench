#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const SECRET_PATTERNS = [
  /sk-(?:ant-)?[A-Za-z0-9_-]{20,}/,
  /AIza[A-Za-z0-9_-]{30,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{20,}/,
  /Bearer\s+[A-Za-z0-9._~+/-]{20,}/i,
  /(?:api[-_]?key|access[-_]?token|client[-_]?secret)['"]?\s*[:=]\s*['"]?[A-Za-z0-9+/=_-]{20,}/i,
]

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

function assertIntegrity(db, label) {
  const rows = db.prepare('PRAGMA integrity_check').all()
  if (rows.length !== 1 || String(Object.values(rows[0])[0]).toLowerCase() !== 'ok') {
    throw new Error(`${label} failed SQLite integrity_check`)
  }
}

function scanForSecrets(db) {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all()
  for (const { name } of tables) {
    const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all()
      .filter((column) => {
        const type = String(column.type || '').toUpperCase()
        return !type || type.includes('CHAR') || type.includes('CLOB') || type.includes('TEXT') || type.includes('JSON')
      })
    if (!columns.length) continue
    const selected = columns.map((column) => quoteIdentifier(column.name)).join(', ')
    for (const row of db.prepare(`SELECT ${selected} FROM ${quoteIdentifier(name)}`).iterate()) {
      for (const [column, value] of Object.entries(row)) {
        if (typeof value !== 'string') continue
        if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
          throw new Error(`plaintext API-key-like content found in SQLite table ${name}, column ${column}`)
        }
      }
    }
  }
}

function snapshot(sourceArg, destinationArg) {
  const source = resolve(sourceArg)
  const destination = resolve(destinationArg)
  if (!existsSync(source)) throw new Error(`source SQLite database does not exist: ${source}`)
  if (existsSync(destination)) throw new Error(`snapshot destination already exists: ${destination}`)
  mkdirSync(dirname(destination), { recursive: true })

  const sourceDb = new DatabaseSync(source, { open: true, readOnly: true })
  try {
    assertIntegrity(sourceDb, source)
    scanForSecrets(sourceDb)
    sourceDb.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`)
  } catch (error) {
    rmSync(destination, { force: true })
    throw error
  } finally {
    sourceDb.close()
  }

  const destinationDb = new DatabaseSync(destination, { open: true, readOnly: true })
  try {
    assertIntegrity(destinationDb, destination)
    scanForSecrets(destinationDb)
  } catch (error) {
    destinationDb.close()
    rmSync(destination, { force: true })
    throw error
  }
  destinationDb.close()
}

function verify(pathArg) {
  const path = resolve(pathArg)
  const db = new DatabaseSync(path, { open: true, readOnly: true })
  try {
    assertIntegrity(db, path)
    scanForSecrets(db)
  } finally {
    db.close()
  }
}

const [command, ...args] = process.argv.slice(2)
try {
  if (command === 'snapshot' && args.length === 2) {
    snapshot(args[0], args[1])
  } else if (command === 'verify' && args.length === 1) {
    verify(args[0])
  } else {
    throw new Error('usage: sqlite-snapshot.mjs snapshot <source> <destination> | verify <database>')
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
