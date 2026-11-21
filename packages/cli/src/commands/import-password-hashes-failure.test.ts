import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'

// `nymbal import --password-hashes` when the store fails a statement mid-file. On Postgres drizzle's error lists every
// value the statement bound, an email and a hash from the file among them; the operator is told the statement and the
// driver's reason, never those values. The error is drizzle's own, thrown by a Postgres client whose connection drops;
// the app that rejects with it is a stand-in, so no database is needed.

const { importLegacyPassword } = vi.hoisted(() => ({ importLegacyPassword: vi.fn() }))

vi.mock('@nymbalhq/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createApp: async () => ({
    services: { auth: { importLegacyPassword } },
    stop: async () => undefined,
  }),
}))

const { runPasswordHashImport } = await import('./import-password-hashes.js')

const HASH = '$P$BJBvrnticjeb6ap2jg6pjQ3IWITdyU0'
const EMAIL = 'shopper-in-the-file@shop.example'

/** drizzle's error for a statement that bound `email` and `hash`, from the platform's own copy of drizzle. */
async function droppedConnectionError(email: string, hash: string): Promise<Error> {
  const fromPlatform = createRequire(new URL('../../../platform/package.json', import.meta.url))
  const { drizzle } = fromPlatform('drizzle-orm/node-postgres') as {
    drizzle: (client: unknown) => { execute: (query: unknown) => Promise<unknown> }
  }
  const { sql } = fromPlatform('drizzle-orm') as {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown
  }
  const db = drizzle({
    query: async () => {
      throw new Error('Connection terminated unexpectedly')
    },
  })
  try {
    await db.execute(
      sql`update customers set password_hash = ${`legacy:wordpress:${hash}`} where email = ${email}`,
    )
  } catch (err) {
    return err as Error
  }
  throw new Error('the statement did not fail')
}

class Exited extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`)
  }
}

const dirs: string[] = []
afterEach(() => {
  importLegacyPassword.mockReset()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function run(): Promise<{ code: number | undefined; out: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'password-hashes-failure-'))
  dirs.push(dir)
  const file = join(dir, 'hashes.tsv')
  writeFileSync(file, `user_email\tuser_pass\n${EMAIL}\t${HASH}\n`)
  const written: string[] = []
  const capture = (...args: unknown[]) => void written.push(args.map(String).join(' '))
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(capture),
    vi.spyOn(console, 'error').mockImplementation(capture),
    vi.spyOn(console, 'warn').mockImplementation(capture),
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (capture(chunk), true)),
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (capture(chunk), true)),
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Exited(code === undefined || code === null ? undefined : Number(code))
    }),
  ]
  const until = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString().slice(0, 10)
  const config = {
    store: { name: 'password-hashes' },
    security: { auth: { legacy: { until, maxCost: 10 } } },
  } as unknown as NymbalConfig
  let code: number | undefined = 0
  try {
    await runPasswordHashImport({ config, file, statePath: join(dir, 'state.json'), dryRun: false })
  } catch (err) {
    if (!(err instanceof Exited)) throw err
    code = err.code
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
  return { code, out: written.join('\n') }
}

describe('nymbal import --password-hashes when a statement fails', () => {
  it('exits 1 naming the failed statement and the driver’s reason, and prints neither the email nor the hash the statement bound', async () => {
    const failure = await droppedConnectionError(EMAIL, HASH)
    expect([failure.message.includes(EMAIL), failure.message.includes(HASH)]).toEqual([true, true])
    importLegacyPassword.mockRejectedValue(failure)

    const { code, out } = await run()

    expect({
      code,
      statement: out.includes('Failed query: update customers set password_hash'),
      reason: out.includes('Connection terminated unexpectedly'),
      bound: [EMAIL, HASH, 'legacy:wordpress'].filter((value) => out.includes(value)),
    }).toEqual({ code: 1, statement: true, reason: true, bound: [] })
  })

  it('a run that stores its line closes by telling the operator to restart or redeploy the store for a changed security.auth.legacy, then to delete the file', async () => {
    importLegacyPassword.mockResolvedValue('stored')

    const { code, out } = await run()
    const lines = out.trim().split('\n')
    const restart = lines.findIndex((l) =>
      /restart or redeploy the store.*security\.auth\.legacy/i.test(l),
    )
    const remove = lines.findIndex((l) => /^Delete .*hashes\.tsv now/.test(l))

    expect([code, importLegacyPassword.mock.calls.length, remove], out).toEqual([
      0,
      1,
      lines.length - 1,
    ])
    expect(restart, out).toBe(remove - 1)
  })
})
