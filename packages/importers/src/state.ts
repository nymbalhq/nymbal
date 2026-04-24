import { readFile, writeFile, unlink } from 'node:fs/promises'
import type { ImportState } from './types.js'

const EMPTY_STATE: Omit<ImportState, 'startedAt' | 'statePath'> = {
  source: 'woocommerce',
  phase: 'connect',
  cursors: {},
  importedIds: { categories: [], products: [], customers: [], orders: [], reviews: [] },
  wcToNymbalCustomer: {},
  wcToNymbalProduct: {},
  wcToNymbalCategory: {},
  errors: [],
  eventsEmitted: 0,
}

export async function loadState(statePath: string): Promise<ImportState | null> {
  try {
    const raw = await readFile(statePath, 'utf-8')
    return JSON.parse(raw) as ImportState
  } catch {
    return null
  }
}

export function freshState(): ImportState {
  return { ...EMPTY_STATE, startedAt: new Date().toISOString() }
}

export async function saveState(statePath: string, state: ImportState): Promise<void> {
  await writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8')
}

export async function deleteState(statePath: string): Promise<void> {
  try {
    await unlink(statePath)
  } catch {
    // file may not exist
  }
}
