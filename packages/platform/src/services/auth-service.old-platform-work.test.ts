import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AuthError } from '@nymbalhq/types'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createEventPublisher, createRelay } from '../index.js'
import { createLogger } from '../logger.js'
import { buildRepositories } from '../repositories/index.js'
import { wirePublisher } from '../tests/publisher.js'
import { createAuthService, DUMMY_PASSWORD, type AuthService } from './auth-service.js'
import { vector } from './fixtures/wordpress-vectors.js'
import type { OldPlatformCheck, RemoteAnswer } from './legacy-remote.js'

// With the old platform's check on and the sunset window open, every refused sign-in still spends the counted work
// of the window (bcrypt to 2^(maxCost - 10) cost-10 units, one phpass of 8,193 MD5 digests, one HMAC-SHA384, no hash),
// whether the old platform was asked or not. A refusal for which a request was sent waits for nothing more; one for
// which none was sent waits once, `sleep(remote.decoyMs())`. The work is counted by delegating mocks of bcryptjs and
// node:crypto, the wait by an injected `sleep`, and the old platform is a scripted check: nothing here is timed.

const ledger = vi.hoisted(() => ({
  on: false,
  compares: [] as Array<{ rounds: number; candidate: string }>,
  hashes: 0,
  md5: 0,
  hmac: 0,
}))

const counting = vi.hoisted(() => {
  type Fn = (...a: unknown[]) => unknown
  return {
    bcrypt(real: Record<string, unknown>) {
      const getRounds = real['getRounds'] as (hash: string) => number
      const rounds = (hash: unknown): number => {
        try {
          return getRounds(hash as string)
        } catch {
          return -1
        }
      }
      // A repeat of a compare is answered from the first, a turn of the event loop later; the ledger still counts it.
      const answers = new Map<string, Promise<unknown>>()
      const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))
      const compare = (s: unknown, hash: unknown) => {
        const key = `${String(hash)}\u0000${String(s)}`
        let work: Promise<unknown>
        if (answers.has(key)) {
          work = nextTurn().then(() => answers.get(key))
        } else {
          work = (real['compare'] as Fn)(s, hash) as Promise<unknown>
          answers.set(key, work)
        }
        return work.then((ok) => {
          if (ledger.on) ledger.compares.push({ rounds: rounds(hash), candidate: String(s) })
          return ok
        })
      }
      const hash = (...args: unknown[]) => {
        if (ledger.on) ledger.hashes += 1
        return (real['hash'] as Fn)(...args)
      }
      const hashSync = (...args: unknown[]) => {
        if (ledger.on) ledger.hashes += 1
        return (real['hashSync'] as Fn)(...args)
      }
      const wrapped = { ...real, compare, hash, hashSync }
      return { ...wrapped, default: wrapped }
    },
    crypto(real: Record<string, unknown>) {
      const createHash = (algorithm: string, ...rest: unknown[]) => {
        if (ledger.on && algorithm.toLowerCase() === 'md5') ledger.md5 += 1
        return (real['createHash'] as Fn)(algorithm, ...rest)
      }
      const createHmac = (algorithm: string, ...rest: unknown[]) => {
        if (ledger.on && algorithm.toLowerCase() === 'sha384') ledger.hmac += 1
        return (real['createHmac'] as Fn)(algorithm, ...rest)
      }
      const wrapped = { ...real, createHash, createHmac }
      return { ...wrapped, default: wrapped }
    },
  }
})

vi.mock('bcryptjs', async (importOriginal) =>
  counting.bcrypt(((await importOriginal()) as { default: Record<string, unknown> }).default),
)
vi.mock('node:crypto', async (importOriginal) =>
  counting.crypto((await importOriginal()) as Record<string, unknown>),
)
vi.mock('crypto', async (importOriginal) =>
  counting.crypto((await importOriginal()) as Record<string, unknown>),
)

const MAX_COST = 12
const REFUSED = 'auth.invalid_credentials: Invalid email or password'
const PHPASS_DIGESTS = 8_193
const DAY_MS = 24 * 60 * 60_000
/** Each class at two lengths, both under the 256 bytes the old platform is ever sent. */
const LENGTHS = [10, 200] as const

/** A wrong password of `bytes` ASCII bytes, never a prefix of anyone's. */
const wrongOf = (bytes: number): string => `zz-wrong-${'w'.repeat(bytes)}`.slice(0, bytes)
const pendingPasswordOf = (bytes: number): string =>
  `pending-right-${'p'.repeat(bytes)}`.slice(0, bytes)
const units = (c: Array<{ rounds: number }>): number =>
  c.reduce((sum, x) => sum + 2 ** (x.rounds - 10), 0)

/** An old platform that answers what the probe scripts, records what it was asked and numbers every decoy. */
function scriptedRemote() {
  const asked: Array<[string, string]> = []
  const decoys: number[] = []
  const state = { answer: { status: 'bad' } as RemoteAnswer }
  const remote: OldPlatformCheck = {
    async check(email: string, password: string) {
      asked.push([email, password])
      return state.answer
    },
    decoyMs() {
      const ms = 4_000 + decoys.length + 1
      decoys.push(ms)
      return ms
    },
  }
  return { remote, asked, decoys, state }
}

interface Spent {
  answer: string
  units: number
  md5: number
  hmac: number
  hashes: number
  /** Compares handed a string other than the public dummy password. */
  notDummy: number
  slept: number[]
  decoys: number[]
  asked: number
}

type Scripted = ReturnType<typeof scriptedRemote>

async function openStore() {
  const store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const logger = createLogger({ pretty: false, level: 'error' })
  const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  const { publisher } = wirePublisher(
    { createEventPublisher, createRelay },
    { store, eventLog: repos.eventLog, eventBus: new InProcessEventBus({ logger }), logger },
  )
  const slept: number[] = []
  const service = (remote: OldPlatformCheck | undefined): AuthService =>
    createAuthService({
      repos,
      publisher,
      logger,
      jwtSecret: 'test-secret-32-characters-long-x',
      accessTtl: '15m',
      refreshTtl: '7d',
      verification: 'required',
      legacy: {
        until: new Date(Date.now() + 30 * DAY_MS),
        maxCost: MAX_COST,
        ...(remote !== undefined && { remote }),
      },
      sleep: async (ms: number) => {
        slept.push(ms)
      },
    })
  return { store, service, slept }
}

type Opened = Awaited<ReturnType<typeof openStore>>

async function spent(
  o: Opened,
  s: Scripted | undefined,
  call: () => Promise<unknown>,
): Promise<Spent> {
  ledger.compares = []
  ledger.hashes = 0
  ledger.md5 = 0
  ledger.hmac = 0
  o.slept.splice(0)
  const decoysBefore = s?.decoys.length ?? 0
  const askedBefore = s?.asked.length ?? 0
  ledger.on = true
  let answer = 'signed in'
  try {
    await call()
  } catch (error) {
    answer =
      error instanceof AuthError ? `${error.code}: ${error.message}` : `threw ${String(error)}`
  } finally {
    ledger.on = false
  }
  return {
    answer,
    units: units(ledger.compares),
    md5: ledger.md5,
    hmac: ledger.hmac,
    hashes: ledger.hashes,
    notDummy: ledger.compares.filter((c) => c.candidate !== DUMMY_PASSWORD).length,
    slept: [...o.slept],
    decoys: s?.decoys.slice(decoysBefore) ?? [],
    asked: (s?.asked.length ?? 0) - askedBefore,
  }
}

const tag = () => randomUUID().slice(0, 8)

interface Probe {
  cls: string
  email: () => string
  password: (bytes: number) => string
  lengths: readonly number[]
  /** What the old platform answers, for a class it is asked about. */
  remote?: RemoteAnswer
  /** Whether a request went out for this refusal. */
  sent: boolean
}

describe('AC-10: with the old platform’s check on, the work and the wait of a refusal', () => {
  let o: Opened
  let s: Scripted
  let auth: AuthService
  const probes: Probe[] = []

  beforeAll(async () => {
    o = await openStore()
    s = scriptedRemote()
    auth = o.service(s.remote)
    const setup = o.service(undefined)
    const legacy = async (hash: string): Promise<string> => {
      const email = `legacy-${tag()}@work.test`
      await setup.importCustomer({ email })
      expect(await setup.importLegacyPassword({ email, recipe: 'wordpress', hash })).toBe('stored')
      return email
    }
    const known = `known-${tag()}@work.test`
    await setup.register({ email: known, password: 'known-correct-horse' })
    const imported = async (): Promise<string> => {
      const email = `imported-${tag()}@work.test`
      await setup.importCustomer({ email })
      return email
    }
    const importedEmails = [await imported(), await imported(), await imported(), await imported()]
    const pending = new Map<number, string>()
    for (const bytes of LENGTHS) {
      const email = `pending-${bytes}-${tag()}@work.test`
      await setup.signUp({ email, password: pendingPasswordOf(bytes) })
      pending.set(bytes, email)
    }
    const fixed = (email: string) => () => email
    const unknown = () => `nobody-${tag()}@work.test`
    const notAsked = (cls: string, email: string): Probe => ({
      cls,
      email: fixed(email),
      password: wrongOf,
      lengths: LENGTHS,
      sent: false,
    })
    probes.push(
      notAsked('known address, wrong password', known),
      notAsked('legacy $P$B, wrong', await legacy(vector('phpass ascii').hash)),
      notAsked('legacy $wp$2y$10$, wrong', await legacy(vector('wp bcrypt 10 ascii').hash)),
      notAsked('legacy $2y$10$, wrong', await legacy(vector('bcrypt 10 ascii').hash)),
      notAsked('legacy $wp$2y$11$, wrong', await legacy(vector('wp bcrypt 11 ascii').hash)),
      notAsked('legacy $wp$2y$12$, wrong', await legacy(vector('wp bcrypt 12 ascii').hash)),
      ...LENGTHS.map(
        (bytes): Probe => ({
          cls: `pending, right password (${bytes} bytes)`,
          email: fixed(pending.get(bytes)!),
          password: pendingPasswordOf,
          lengths: [bytes],
          sent: false,
        }),
      ),
      {
        cls: 'unknown, asked and refused',
        email: unknown,
        password: wrongOf,
        lengths: LENGTHS,
        remote: { status: 'bad' },
        sent: true,
      },
      {
        cls: 'unknown, asked and unavailable',
        email: unknown,
        password: wrongOf,
        lengths: LENGTHS,
        remote: { status: 'unavailable' },
        sent: true,
      },
      {
        cls: 'imported, asked and refused',
        email: fixed(importedEmails[0]!),
        password: wrongOf,
        lengths: LENGTHS,
        remote: { status: 'bad' },
        sent: true,
      },
      {
        cls: 'imported, asked and unavailable',
        email: fixed(importedEmails[1]!),
        password: wrongOf,
        lengths: LENGTHS,
        remote: { status: 'unavailable' },
        sent: true,
      },
      {
        cls: 'unknown, a password over 256 bytes',
        email: unknown,
        password: wrongOf,
        lengths: [257, 4_097],
        remote: { status: 'skipped', why: 'input' },
        sent: false,
      },
      {
        cls: 'unknown, capped',
        email: unknown,
        password: wrongOf,
        lengths: LENGTHS,
        remote: { status: 'skipped', why: 'cap' },
        sent: false,
      },
      {
        cls: 'unknown, breaker open',
        email: unknown,
        password: wrongOf,
        lengths: LENGTHS,
        remote: { status: 'skipped', why: 'breaker' },
        sent: false,
      },
      {
        cls: 'imported, capped',
        email: fixed(importedEmails[2]!),
        password: wrongOf,
        lengths: LENGTHS,
        remote: { status: 'skipped', why: 'cap' },
        sent: false,
      },
      {
        cls: 'imported, breaker open',
        email: fixed(importedEmails[3]!),
        password: wrongOf,
        lengths: LENGTHS,
        remote: { status: 'skipped', why: 'breaker' },
        sent: false,
      },
    )
  }, 60_000)

  afterAll(async () => {
    await o?.store.close()
  })

  it('AC-10: every refusal class, asked or not, spends the window’s ledger; one that sent a request calls sleep zero times, one that sent none calls it once with remote.decoyMs()', async () => {
    const got: Array<[string, number, unknown]> = []
    const want: Array<[string, number, unknown]> = []
    for (const p of probes) {
      for (const bytes of p.lengths) {
        s.state.answer = p.remote ?? { status: 'bad' }
        const r = await spent(o, s, () => auth.login(p.email(), p.password(bytes)))
        got.push([
          p.cls,
          bytes,
          { ...r, sleptIsDecoy: r.slept.length === 1 && r.slept[0] === r.decoys[0] },
        ])
        want.push([
          p.cls,
          bytes,
          {
            answer: REFUSED,
            units: 2 ** (MAX_COST - 10),
            md5: PHPASS_DIGESTS,
            hmac: 1,
            hashes: 0,
            notDummy: 1,
            slept: p.sent ? [] : r.decoys,
            decoys: r.decoys,
            asked: p.remote === undefined ? 0 : 1,
            sleptIsDecoy: !p.sent,
          },
        ])
      }
    }
    expect(got).toEqual(want)
  }, 240_000)

  it('AC-10: a sign-in calls sleep zero times (a native right password, an unknown address the old platform vouches for), and with remote unset sleep is never called for any class', async () => {
    const native = `native-${tag()}@work.test`
    const plain = o.service(undefined)
    await plain.register({ email: native, password: 'native-correct-horse' })
    s.state.answer = { status: 'ok', profile: { firstName: 'Ada' } }
    const signIns = [
      await spent(o, s, () => auth.login(native, 'native-correct-horse')),
      await spent(o, s, () => auth.login(`vouched-${tag()}@work.test`, 'old-platform-password')),
    ]
    const unset: Array<[string, string, number[]]> = []
    for (const p of probes) {
      for (const bytes of p.lengths) {
        const r = await spent(o, undefined, () => plain.login(p.email(), p.password(bytes)))
        unset.push([p.cls, r.answer, r.slept])
      }
    }
    const signIn = await spent(o, undefined, () => plain.login(native, 'native-correct-horse'))
    unset.push(['native sign-in', signIn.answer, signIn.slept])

    expect(signIns.map((r) => [r.answer, r.slept, r.asked])).toEqual([
      ['signed in', [], 0],
      ['signed in', [], 1],
    ])
    expect(unset).toEqual([
      ...probes.flatMap((p) =>
        p.lengths.map((): [string, string, number[]] => [p.cls, REFUSED, []]),
      ),
      ['native sign-in', 'signed in', []],
    ])
  }, 240_000)
})
