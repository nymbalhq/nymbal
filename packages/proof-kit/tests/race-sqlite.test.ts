import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sqliteInventory, stockRaceRuns, type Inventory } from './fixtures/inventory'

// Acceptance tests for P1-01 AC-3 and AC-4: on a fresh SQLite file, 50 buyers race for 3 units, 10 consecutive
// runs. The correct conditional decrement is reported clean every time; the broken read-then-write one is caught
// every time (the roadmap proof that the kit sees a broken decrement).

const RACE = { runs: 10, contenders: 50, units: 3 }

let dir: string
let inventory: Inventory

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'proof-kit-race-'))
  inventory = sqliteInventory(join(dir, 'inventory.sqlite'))
})

afterAll(async () => {
  await inventory?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('AC-3: SQLite, the correct decrement', () => {
  it('AC-3: 50 contenders for 3 units: checkStock is [], wins = 3, final 0, in each of 10 consecutive runs', async () => {
    const runs = await stockRaceRuns(inventory, 'decrementCorrect', RACE)

    expect(runs).toHaveLength(RACE.runs)
    for (const run of runs) {
      expect(run.wins + run.lost).toBe(run.contenders)
      expect(run.final).toBe(run.initial - run.wins)
    }
    expect(
      runs.map(({ violations, wins, final, unexpected }) => ({
        violations,
        wins,
        final,
        unexpected,
      })),
    ).toEqual(
      Array.from({ length: RACE.runs }, () => ({
        violations: [],
        wins: RACE.units,
        final: 0,
        unexpected: 0,
      })),
    )
  }, 30_000)
})

describe('AC-4: SQLite, the broken decrement', () => {
  it('AC-4: the same race with decrementBroken: checkStock reports wins-within-stock or stock-conserved in each of 10 consecutive runs', async () => {
    const runs = await stockRaceRuns(inventory, 'decrementBroken', RACE)

    expect(runs).toHaveLength(RACE.runs)
    const caught = runs.map((run) =>
      run.violations.some(
        (v) => v.invariant === 'wins-within-stock' || v.invariant === 'stock-conserved',
      ),
    )
    expect(caught).toEqual(Array.from({ length: RACE.runs }, () => true))
    for (const run of runs) {
      expect(run.wins + run.lost).toBe(run.contenders)
      expect(run.unexpected).toBe(0)
    }
  }, 30_000)
})
