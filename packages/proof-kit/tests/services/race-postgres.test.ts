import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postgresInventory, stockRaceRuns, type Inventory } from '../fixtures/inventory'

// AC-5: AC-3 and AC-4 on Postgres, in a fresh database for this file, 10 runs each.
// The file refuses to load without NYMBAL_TEST_POSTGRES_URL, so a missing server fails the proof-kit-services
// project: it can never skip or pass.

const URL_VAR = 'NYMBAL_TEST_POSTGRES_URL'
const serverUrl = process.env[URL_VAR]
if (serverUrl === undefined || serverUrl.trim() === '') {
  throw new Error(
    `${URL_VAR} is not set: the proof-kit-services project needs a Postgres server ` +
      `(pnpm gate:full starts one with docker compose; e.g. ${URL_VAR}=postgres://postgres:nymbal@localhost:54329/nymbal)`,
  )
}

const RACE = { runs: 10, contenders: 50, units: 3 }

let inventory: Inventory

beforeAll(async () => {
  inventory = await postgresInventory(serverUrl!)
}, 30_000)

afterAll(async () => {
  await inventory?.close()
})

describe('AC-5: the stock race on Postgres', () => {
  it('AC-5 (AC-3 on Postgres): the correct decrement: checkStock is [], wins = 3, final 0, in each of 10 consecutive runs', async () => {
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
  }, 60_000)

  it('AC-5 (AC-4 on Postgres): the broken decrement: checkStock reports wins-within-stock or stock-conserved in each of 10 consecutive runs', async () => {
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
  }, 60_000)
})
