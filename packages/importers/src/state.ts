import { randomUUID } from 'node:crypto'
import { appendFile, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { ImportEntity, ImportState, ImportWarning } from './types.js'

export const ENTITIES: readonly ImportEntity[] = [
  'categories',
  'products',
  'customers',
  'orders',
  'reviews',
]

/** The map from WooCommerce id to Nymbal id each entity keeps, so a resumed run skips what it created. */
const MAP_OF = {
  categories: 'wcToNymbalCategory',
  products: 'wcToNymbalProduct',
  customers: 'wcToNymbalCustomer',
  orders: 'wcToNymbalOrder',
  reviews: 'wcToNymbalReview',
} as const satisfies Record<ImportEntity, keyof ImportState>

const EMPTY_STATE: Omit<ImportState, 'startedAt' | 'rollbackSince'> = {
  source: 'woocommerce',
  phase: 'connect',
  cursors: {},
  importedIds: { categories: [], products: [], customers: [], orders: [], reviews: [] },
  wcToNymbalCustomer: {},
  wcToNymbalProduct: {},
  wcToNymbalCategory: {},
  wcToNymbalOrder: {},
  wcToNymbalReview: {},
  errors: [],
  warnings: [],
  eventsEmitted: 0,
  runs: [],
  finished: [],
}

/** A state file that is there but cannot be read as a state: the run stops rather than start again and forget it. */
export class ImportStateError extends Error {
  readonly path: string
  constructor(path: string, reason: string) {
    super(
      `${path} cannot be read as an import state (${reason}). Restore it, or move it aside to start a new import.`,
    )
    this.name = 'ImportStateError'
    this.path = path
  }
}

/** A record an import created, appended once its create resolves, with what its import could not carry over. */
export interface JournalEntry {
  entity: ImportEntity
  id: string
  wcId: number
  /** Warning messages about the record, each reported under its entity and WooCommerce id. */
  warnings?: string[]
  /** Messages about the record's images that were not imported, each reported under `media` and its WooCommerce id. */
  mediaWarnings?: string[]
}

/** A record a rollback removed. */
interface JournalRemoval {
  entity: ImportEntity
  id: string
  op: 'removed'
}

/** The journal beside the state file: `.nymbal-migration.journal` for `.nymbal-migration.json`. */
export function journalPathFor(statePath: string): string {
  const name = basename(statePath)
  const stem = name.endsWith('.json') ? name.slice(0, -'.json'.length) : name
  return join(dirname(statePath), `${stem}.journal`)
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function parseState(path: string, raw: string): ImportState {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new ImportStateError(path, `not JSON: ${(err as Error).message}`)
  }
  if (!isObject(parsed)) throw new ImportStateError(path, 'not an object')
  const ids = parsed['importedIds']
  if (!isObject(ids)) throw new ImportStateError(path, 'no importedIds')
  for (const e of ENTITIES) {
    const list = ids[e]
    if (!Array.isArray(list) || !list.every((id) => typeof id === 'string')) {
      throw new ImportStateError(path, `importedIds.${e} is not a list of ids`)
    }
  }
  for (const map of Object.values(MAP_OF)) {
    if (parsed[map] !== undefined && !isObject(parsed[map])) {
      throw new ImportStateError(path, `${map} is not a map`)
    }
  }
  if (parsed['warnings'] !== undefined && !Array.isArray(parsed['warnings'])) {
    throw new ImportStateError(path, 'warnings is not a list')
  }
  const finished = parsed['finished']
  if (
    finished !== undefined &&
    !(Array.isArray(finished) && finished.every((e) => ENTITIES.includes(e as ImportEntity)))
  ) {
    throw new ImportStateError(path, 'finished is not a list of entities')
  }
  const state = parsed as unknown as ImportState
  // A state saved before the order and review maps, the rollback start and warnings existed.
  state.wcToNymbalOrder ??= {}
  state.wcToNymbalReview ??= {}
  state.rollbackSince ??= state.startedAt
  state.warnings ??= []
  const done = state.phase === 'done'
  // A state saved before passes were recorded: a finished one stands for one pass, from its start, over the entities
  // it holds records of (orders by their ids: a state older than the order map has an empty one).
  if (state.runs === undefined) {
    const entities = ENTITIES.filter((e) => state.importedIds[e].length > 0)
    state.runs = done ? [{ startedAt: state.startedAt, finishedAt: state.startedAt, entities }] : []
  }
  // Before `finished`, a done state had walked each entity its run was asked for, and only those have a cursor.
  state.finished ??= done ? ENTITIES.filter((e) => state.cursors[e] !== undefined) : []
  return state
}

function journalLine(line: string): JournalEntry | JournalRemoval | null {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObject(v) || typeof v['id'] !== 'string') return null
  if (!ENTITIES.includes(v['entity'] as ImportEntity)) return null
  if (v['op'] === 'removed') return v as unknown as JournalRemoval
  if (typeof v['wcId'] !== 'number') return null
  const strings = (field: unknown) =>
    Array.isArray(field) ? field.filter((w): w is string => typeof w === 'string') : []
  return {
    entity: v['entity'] as ImportEntity,
    id: v['id'],
    wcId: v['wcId'],
    warnings: strings(v['warnings']),
    mediaWarnings: strings(v['mediaWarnings']),
  }
}

/**
 * Adds a warning to the state unless one with the same phase, id and message is there: a resumed run meets again
 * what an earlier run warned about.
 */
export function warningAdder(state: ImportState): (warning: ImportWarning) => void {
  const key = (w: ImportWarning) => JSON.stringify([w.phase, w.id ?? null, w.message])
  const held = new Set(state.warnings.map(key))
  return (warning) => {
    const k = key(warning)
    if (held.has(k)) return
    held.add(k)
    state.warnings.push(warning)
  }
}

/**
 * Applies the journal to the state: each creation adds its id, its WooCommerce mapping and its warnings, each removal
 * takes the id and the mapping out. A line that does not parse is one a crash cut short, and is skipped. Applying the
 * same journal twice gives the same state.
 */
function foldJournal(state: ImportState, journal: string): void {
  const held = Object.fromEntries(
    ENTITIES.map((e) => [e, new Set(state.importedIds[e])]),
  ) as Record<ImportEntity, Set<string>>
  const removed = new Set<string>()
  const warn = warningAdder(state)
  for (const line of journal.split('\n')) {
    if (line.trim() === '') continue
    const entry = journalLine(line)
    if (entry === null) continue
    if ('op' in entry) {
      held[entry.entity].delete(entry.id)
      removed.add(entry.id)
    } else {
      held[entry.entity].add(entry.id)
      state[MAP_OF[entry.entity]][entry.wcId] = entry.id
      for (const message of entry.warnings ?? []) {
        warn({ phase: entry.entity, id: String(entry.wcId), message })
      }
      for (const message of entry.mediaWarnings ?? []) {
        warn({ phase: 'media', id: String(entry.wcId), message })
      }
    }
  }
  for (const e of ENTITIES) {
    state.importedIds[e] = [...held[e]]
    if (removed.size === 0) continue
    const map = state[MAP_OF[e]]
    for (const [wcId, id] of Object.entries(map)) if (removed.has(id)) delete map[wcId]
  }
}

/** The saved state with its journal folded in; null only when there is no state file. */
export async function loadState(statePath: string): Promise<ImportState | null> {
  let raw: string
  try {
    raw = await readFile(statePath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new ImportStateError(statePath, (err as Error).message)
  }
  const state = parseState(statePath, raw)
  let journal = ''
  try {
    journal = await readFile(journalPathFor(statePath), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  foldJournal(state, journal)
  return state
}

export function freshState(): ImportState {
  const now = new Date().toISOString()
  return { ...structuredClone(EMPTY_STATE), startedAt: now, rollbackSince: now }
}

/** Writes beside the target, syncs, then renames over it: the file at the path is always a whole state. */
export async function saveState(statePath: string, state: ImportState): Promise<void> {
  const temp = join(dirname(statePath), `.${basename(statePath)}.${randomUUID()}.tmp`)
  try {
    const file = await open(temp, 'w')
    try {
      await file.writeFile(JSON.stringify(state, null, 2), 'utf-8')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temp, statePath)
  } catch (err) {
    await rm(temp, { force: true })
    throw err
  }
}

export async function appendJournal(statePath: string, entry: JournalEntry): Promise<void> {
  const line: JournalEntry = { entity: entry.entity, id: entry.id, wcId: entry.wcId }
  if (entry.warnings !== undefined && entry.warnings.length > 0) line.warnings = entry.warnings
  if (entry.mediaWarnings !== undefined && entry.mediaWarnings.length > 0) {
    line.mediaWarnings = entry.mediaWarnings
  }
  await appendFile(journalPathFor(statePath), `${JSON.stringify(line)}\n`, 'utf-8')
}

/** Records that a rollback removed the record, so a rollback run again does not look for it. */
export async function appendRemoval(
  statePath: string,
  entity: ImportEntity,
  id: string,
): Promise<void> {
  const line: JournalRemoval = { entity, id, op: 'removed' }
  await appendFile(journalPathFor(statePath), `${JSON.stringify(line)}\n`, 'utf-8')
}

/**
 * Saves the state, its journal folded in, and starts the journal again. A run does this before it writes anything,
 * so the journal holds only that run's lines, and a line a crash cut short is never followed by another.
 */
export async function compactState(statePath: string, state: ImportState): Promise<void> {
  await saveState(statePath, state)
  await rm(journalPathFor(statePath), { force: true })
}

/** Removes the state file and its journal. */
export async function deleteState(statePath: string): Promise<void> {
  await rm(statePath, { force: true })
  await rm(journalPathFor(statePath), { force: true })
}
