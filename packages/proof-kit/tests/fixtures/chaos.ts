import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

// P1-01 chaos fixtures: paths to the child scripts, a temp SQLite file and marker per case, and readers for both.

export const CHAOS_CHILD = fileURLToPath(new URL('./chaos-child.mjs', import.meta.url))
export const CHAOS_ORDER_CHILD = fileURLToPath(new URL('./chaos-order-child.mjs', import.meta.url))

export type ChildStep =
  | { op: 'write'; id: string }
  | { op: 'publish'; type: string }
  | { op: 'batch'; types: string[] }
  | { op: 'exit'; code: number }
  | { op: 'hang' }

export interface ChaosCase {
  db: string
  marker: string
  /** The child's argv for this case and plan. */
  args(plan: ChildStep[]): string[]
}

const dirs: string[] = []

export function chaosCase(): ChaosCase {
  const dir = mkdtempSync(join(tmpdir(), 'proof-kit-chaos-'))
  dirs.push(dir)
  const db = join(dir, 'store.sqlite')
  const marker = join(dir, 'delivered.txt')
  return { db, marker, args: (plan) => [db, marker, JSON.stringify(plan)] }
}

export function removeChaosCases(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/** The event types the child's subscriber saw, in delivery order. */
export function delivered(marker: string): string[] {
  if (!existsSync(marker)) return []
  return readFileSync(marker, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
}

/** Rows of `sql` in the SQLite file a killed child left behind, reopened read-only. */
export function readRows<T>(file: string, sql: string): T[] {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    return db.prepare(sql).all() as T[]
  } finally {
    db.close()
  }
}

/** The environment without the chaos variable, so a control run is not armed. */
export function envWithout(name: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== name && value !== undefined) env[key] = value
  }
  return env
}
