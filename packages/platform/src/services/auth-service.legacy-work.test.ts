import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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
import { nearValidStored, vector, type MaxCost } from './fixtures/wordpress-vectors.js'

// Every refused sign-in spends the same counted work, whatever the address holds and however long the typed password
// is. Inside the sunset window that is bcrypt summing to 2^(maxCost - 10) cost-10 units, one phpass of 8,193 MD5
// digests over at most 256 bytes, and one HMAC-SHA384 over at most 4,096 bytes; outside it, one cost-10 compare. A
// right password spends only its own check. The work is counted, not timed: bcryptjs and node:crypto are wrapped by
// delegating mocks that record each compare's cost and string, each bcrypt.hash, each MD5 and SHA-384 HMAC, and the
// bytes passed to every update. Nothing here depends on the machine's speed.

const ledger = vi.hoisted(() => ({
  on: false,
  compares: [] as Array<{ rounds: number; candidate: string }>,
  hashes: 0,
  md5: 0,
  md5Bytes: 0,
  hmac: 0,
  hmacBytes: 0,
}))

const counting = vi.hoisted(() => {
  type Fn = (...a: unknown[]) => unknown
  // Two phpass runs' worth: past it, a loop is trusting stored parameters, and the count already says so.
  const MD5_CEILING = 2 * 8_193
  const bytesOf = (data: unknown, encoding?: unknown): number => {
    if (typeof data === 'string') {
      return Buffer.byteLength(data, (encoding as BufferEncoding | undefined) ?? 'utf8')
    }
    return (data as ArrayBufferView).byteLength
  }
  const metered = <T extends { update: Fn }>(object: T, add: (n: number) => void): T => {
    const update = object.update.bind(object)
    object.update = (data: unknown, encoding?: unknown) => {
      add(bytesOf(data, encoding))
      update(data, encoding)
      return object
    }
    return object
  }
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
      const record = (s: unknown, hash: unknown): number => {
        const r = rounds(hash)
        if (ledger.on) ledger.compares.push({ rounds: r, candidate: String(s) })
        return r
      }
      // bcrypt is a pure function of the string and the hash, and the probes repeat (every padding compare, every
      // password past 72 bytes), so a repeat is answered from the first without the work. The ledger still counts it.
      // A compare is counted when it settles, and a repeat settles no sooner than the next turn of the event loop, so
      // a compare the sign-in does not wait for lands after the sign-in's ledger has closed and is missing from it.
      const answers = new Map<string, Promise<unknown>>()
      const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))
      const compare = (s: unknown, hash: unknown, ...rest: unknown[]) => {
        if (rest.length > 0)
          throw new Error('the ledger counts the promise form of bcrypt.compare only')
        const key = `${String(hash)}\u0000${String(s)}`
        let work: Promise<unknown>
        if (rounds(hash) > 12) {
          work = nextTurn().then(() => Promise.reject(new Error('bcrypt over any store’s cost')))
        } else if (answers.has(key)) {
          work = nextTurn().then(() => answers.get(key))
        } else {
          work = (real['compare'] as Fn)(s, hash) as Promise<unknown>
          answers.set(key, work)
        }
        return work.then(
          (ok) => {
            record(s, hash)
            return ok
          },
          (error: unknown) => {
            record(s, hash)
            throw error
          },
        )
      }
      const compareSync = (s: unknown, hash: unknown) => {
        if (record(s, hash) > 12) throw new Error('bcrypt over any store’s cost')
        return (real['compareSync'] as Fn)(s, hash)
      }
      const hash = (...args: unknown[]) => {
        if (ledger.on) ledger.hashes += 1
        return (real['hash'] as Fn)(...args)
      }
      const hashSync = (...args: unknown[]) => {
        if (ledger.on) ledger.hashes += 1
        return (real['hashSync'] as Fn)(...args)
      }
      const wrapped = { ...real, compare, compareSync, hash, hashSync }
      return { ...wrapped, default: wrapped }
    },
    crypto(real: Record<string, unknown>) {
      const createHash = (algorithm: string, ...rest: unknown[]) => {
        const made = (real['createHash'] as Fn)(algorithm, ...rest) as { update: Fn }
        if (!ledger.on || algorithm.toLowerCase() !== 'md5') return made
        ledger.md5 += 1
        if (ledger.md5 > MD5_CEILING)
          throw new Error(`over ${MD5_CEILING} MD5 digests in one sign-in`)
        return metered(made, (n) => (ledger.md5Bytes += n))
      }
      const createHmac = (algorithm: string, ...rest: unknown[]) => {
        const made = (real['createHmac'] as Fn)(algorithm, ...rest) as { update: Fn }
        if (!ledger.on || algorithm.toLowerCase() !== 'sha384') return made
        ledger.hmac += 1
        return metered(made, (n) => (ledger.hmacBytes += n))
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

interface Spent {
  compares: Array<{ rounds: number; candidate: string }>
  hashes: number
  md5: number
  md5Bytes: number
  hmac: number
  hmacBytes: number
  answer: string
}

/** One sign-in, and the work it did. */
async function spent(call: () => Promise<unknown>): Promise<Spent> {
  ledger.compares = []
  ledger.hashes = 0
  ledger.md5 = 0
  ledger.md5Bytes = 0
  ledger.hmac = 0
  ledger.hmacBytes = 0
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
    compares: [...ledger.compares],
    hashes: ledger.hashes,
    md5: ledger.md5,
    md5Bytes: ledger.md5Bytes,
    hmac: ledger.hmac,
    hmacBytes: ledger.hmacBytes,
    answer,
  }
}

const REFUSED = 'auth.invalid_credentials: Invalid email or password'
const PHPASS_DIGESTS = 8_193
const PHPASS_MAX_BYTES = 256
const LEGACY_MAX_BYTES = 4_096
const BCRYPT_MAX_CODE_POINTS = 72
const HMAC_BASE64_LENGTH = 64
const LENGTHS = [10, 300, 4_096, 4_097, 100_000] as const
const DAY_MS = 24 * 60 * 60_000

const units = (s: Spent): number => s.compares.reduce((sum, c) => sum + 2 ** (c.rounds - 10), 0)
const codePoints = (s: string): number => Array.from(s).length
const longest = (s: Spent): number => Math.max(0, ...s.compares.map((c) => codePoints(c.candidate)))
const candidates = (s: Spent) => s.compares.filter((c) => c.candidate !== DUMMY_PASSWORD)

/** A wrong password of `bytes` ASCII bytes, never a prefix of anyone's. */
const wrongOf = (bytes: number): string => `zz-wrong-${'w'.repeat(bytes)}`.slice(0, bytes)
const pendingPasswordOf = (bytes: number): string =>
  `pending-right-${'p'.repeat(bytes)}`.slice(0, bytes)

interface Probe {
  cls: string
  /** The row's own compare is handed the WordPress HMAC, not the typed password. */
  wp: boolean
  email: string
  password: (bytes: number) => string
}

async function openClasses(m: MaxCost) {
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
  const service = (legacy?: { until?: Date; maxCost: MaxCost }): AuthService =>
    createAuthService({
      repos,
      publisher,
      logger,
      jwtSecret: 'test-secret-32-characters-long-x',
      accessTtl: '15m',
      refreshTtl: '7d',
      verification: 'required',
      ...(legacy !== undefined && { legacy }),
    })
  const open = service({ until: new Date(Date.now() + 30 * DAY_MS), maxCost: m })
  const tag = () => randomUUID().slice(0, 8)

  async function legacy(hash: string): Promise<string> {
    const email = `legacy-${tag()}@work.test`
    await open.importCustomer({ email })
    expect(await open.importLegacyPassword({ email, recipe: 'wordpress', hash })).toBe('stored')
    return email
  }

  /** A row holding `stored` as it is, written past the import's checks, as a hand edit or a bad migration would. */
  async function broken(): Promise<{ email: string; hold: (stored: string) => Promise<void> }> {
    const email = `broken-${tag()}@work.test`
    const { id } = await open.importCustomer({ email })
    return {
      email,
      hold: (stored) =>
        store.transaction((tx) =>
          repos.customer.update(tx, id, { passwordHash: stored, updatedAt: new Date() }),
        ),
    }
  }

  const known = `known-${tag()}@work.test`
  await open.register({ email: known, password: 'known-correct-horse' })
  const imported = `imported-${tag()}@work.test`
  await open.importCustomer({ email: imported })
  const pending = new Map<number, string>()
  for (const bytes of LENGTHS) {
    const email = `pending-${bytes}-${tag()}@work.test`
    await open.signUp({ email, password: pendingPasswordOf(bytes) })
    pending.set(bytes, email)
  }

  const probes: Probe[] = [
    { cls: 'known address, wrong password', wp: false, email: known, password: wrongOf },
    { cls: 'unknown address', wp: false, email: `nobody-${tag()}@work.test`, password: wrongOf },
    { cls: 'imported, no hash', wp: false, email: imported, password: wrongOf },
    {
      cls: 'legacy $P$B, wrong',
      wp: false,
      email: await legacy(vector('phpass ascii').hash),
      password: wrongOf,
    },
    {
      cls: 'legacy $wp$2y$10$, wrong',
      wp: true,
      email: await legacy(vector('wp bcrypt 10 ascii').hash),
      password: wrongOf,
    },
    {
      cls: 'legacy $2y$10$, wrong',
      wp: false,
      email: await legacy(vector('bcrypt 10 ascii').hash),
      password: wrongOf,
    },
  ]
  if (m === 12) {
    probes.push(
      {
        cls: 'legacy $wp$2y$11$, wrong',
        wp: true,
        email: await legacy(vector('wp bcrypt 11 ascii').hash),
        password: wrongOf,
      },
      {
        cls: 'legacy $wp$2y$12$, wrong',
        wp: true,
        email: await legacy(vector('wp bcrypt 12 ascii').hash),
        password: wrongOf,
      },
    )
  }
  // One account per length, so its right password is that long.
  const pendingProbe = (bytes: number): Probe => ({
    cls: 'pending, right password',
    wp: false,
    email: pending.get(bytes)!,
    password: pendingPasswordOf,
  })

  return { store, repos, service, open, probes, pendingProbe, legacy, broken }
}

type Classes = Awaited<ReturnType<typeof openClasses>>

/** What the criterion asks of every refusal in the window, for one class at one length. */
function windowRefusal(s: Spent, m: MaxCost, probe: Probe, bytes: number) {
  const own = candidates(s)
  return {
    answer: s.answer,
    units: units(s),
    md5: s.md5,
    hmac: s.hmac,
    hashes: s.hashes,
    notDummy: own.length,
    candidateLength: own[0] === undefined ? -1 : codePoints(own[0].candidate),
    longestWithin72: longest(s) <= BCRYPT_MAX_CODE_POINTS,
    md5BytesWithinCap: s.md5Bytes <= PHPASS_DIGESTS * (16 + PHPASS_MAX_BYTES),
    hmacBytesWithinCap: s.hmacBytes <= LEGACY_MAX_BYTES,
    expected: {
      answer: REFUSED,
      units: 2 ** (m - 10),
      md5: PHPASS_DIGESTS,
      hmac: 1,
      hashes: 0,
      notDummy: 1,
      candidateLength:
        probe.wp && bytes <= LEGACY_MAX_BYTES
          ? HMAC_BASE64_LENGTH
          : Math.min(bytes, BCRYPT_MAX_CODE_POINTS),
    },
  }
}

function expectWindowRefusal(s: Spent, m: MaxCost, probe: Probe, bytes: number): void {
  const got = windowRefusal(s, m, probe, bytes)
  const label = `${probe.cls} at ${bytes} bytes, maxCost ${m}`
  expect(
    {
      answer: got.answer,
      units: got.units,
      md5: got.md5,
      hmac: got.hmac,
      hashes: got.hashes,
      notDummy: got.notDummy,
      candidateLength: got.candidateLength,
    },
    label,
  ).toEqual(got.expected)
  expect([got.longestWithin72, got.md5BytesWithinCap, got.hmacBytesWithinCap], label).toEqual([
    true,
    true,
    true,
  ])
}

for (const m of [10, 12] as const) {
  describe(`AC-5: the window open at maxCost ${m}, every refusal spends one ledger`, () => {
    let c: Classes
    beforeAll(async () => {
      c = await openClasses(m)
    }, 60_000)
    afterAll(async () => {
      await c?.store.close()
    })

    it(`AC-5: each class (known, unknown, imported without a hash, legacy $P$B, $wp$2y$10$ and $2y$10$${m === 12 ? ', $wp$2y$11$, $wp$2y$12$' : ''}, a pending account with its right password) at 10, 300, 4096, 4097 and about 100 000 bytes spends bcrypt summing to ${2 ** (m - 10)} unit(s), exactly 8,193 MD5 digests, one HMAC and no hash, hands exactly one compare a string other than DUMMY_PASSWORD and none more than 72 code points, and every class passes MD5 and HMAC the same bytes at each length`, async () => {
      for (const bytes of LENGTHS) {
        const byClass: Array<[string, number, number]> = []
        for (const probe of [...c.probes, c.pendingProbe(bytes)]) {
          const s = await spent(() => c.open.login(probe.email, probe.password(bytes)))
          expectWindowRefusal(s, m, probe, bytes)
          byClass.push([probe.cls, s.md5Bytes, s.hmacBytes])
        }
        const [, md5Bytes, hmacBytes] = byClass[0]!
        expect(byClass, `MD5 and HMAC bytes at ${bytes} bytes`).toEqual(
          byClass.map(([cls]) => [cls, md5Bytes, hmacBytes]),
        )
      }
    }, 240_000)

    it(`AC-5: a row holding a broken stored value (one field of an accepted shape broken) spends the same ledger as an unknown address, at every length`, async () => {
      const row = await c.broken()
      const unknown = c.probes.find((p) => p.cls === 'unknown address')!
      const reference = new Map<number, Spent>()
      for (const bytes of LENGTHS) {
        reference.set(bytes, await spent(() => c.open.login(unknown.email, wrongOf(bytes))))
      }
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...nearValidStored(m)),
          fc.constantFrom(...LENGTHS),
          async (n, bytes) => {
            await row.hold(n.stored)
            const probe: Probe = {
              cls: `broken: ${n.label}`,
              wp: false,
              email: row.email,
              password: wrongOf,
            }
            const s = await spent(() => c.open.login(row.email, wrongOf(bytes)))
            expectWindowRefusal(s, m, probe, bytes)
            const ref = reference.get(bytes)!
            expect([s.md5Bytes, s.hmacBytes], probe.cls).toEqual([ref.md5Bytes, ref.hmacBytes])
          },
        ),
        { numRuns: 12 },
      )
    }, 240_000)
  })
}

describe('AC-5: outside the window every refusal spends one cost-10 compare', () => {
  let c: Classes
  beforeAll(async () => {
    c = await openClasses(12)
  }, 60_000)
  afterAll(async () => {
    await c?.store.close()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const closed = (s: Spent) => ({
    answer: s.answer,
    rounds: s.compares.map((x) => x.rounds),
    within72: longest(s) <= BCRYPT_MAX_CODE_POINTS,
    md5: s.md5,
    hmac: s.hmac,
    hashes: s.hashes,
  })
  const CLOSED = { answer: REFUSED, rounds: [10], within72: true, md5: 0, hmac: 0, hashes: 0 }

  it('AC-5: with no until (a legacy block with only maxCost 12), every class at every length spends one cost-10 compare of at most 72 code points and no MD5, HMAC or hash', async () => {
    const auth = c.service({ maxCost: 12 })
    for (const bytes of LENGTHS) {
      for (const probe of [...c.probes, c.pendingProbe(bytes)]) {
        const s = await spent(() => auth.login(probe.email, probe.password(bytes)))
        expect(closed(s), `${probe.cls} at ${bytes} bytes`).toEqual(CLOSED)
      }
    }
  }, 240_000)

  it('AC-5: at until exactly (now >= until), every class at 10 and about 100 000 bytes spends one cost-10 compare and no MD5, HMAC or hash', async () => {
    const until = new Date(Date.now() + DAY_MS)
    const auth = c.service({ until, maxCost: 12 })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(until)
    for (const bytes of [10, 100_000]) {
      for (const probe of [...c.probes, c.pendingProbe(bytes)]) {
        const s = await spent(() => auth.login(probe.email, probe.password(bytes)))
        expect(closed(s), `${probe.cls} at ${bytes} bytes`).toEqual(CLOSED)
      }
    }
  }, 240_000)

  it('AC-7: at until, the right WordPress password spends the closed-window ledger: one cost-10 compare, no MD5, HMAC or hash', async () => {
    const until = new Date(Date.now() + DAY_MS)
    const auth = c.service({ until, maxCost: 12 })
    const answers: Array<[string, ReturnType<typeof closed>]> = []
    const rights = [
      'phpass ascii',
      'wp bcrypt 10 ascii',
      'bcrypt 10 ascii',
      'wp bcrypt 12 ascii',
    ].map(vector)
    const emails = await Promise.all(rights.map((v) => c.legacy(v.hash)))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(until)
    for (const [i, v] of rights.entries()) {
      answers.push([v.name, closed(await spent(() => auth.login(emails[i]!, v.password)))])
    }
    expect(answers).toEqual(rights.map((v) => [v.name, CLOSED]))
  }, 60_000)
})

describe('AC-5: a sign-in is not padded', () => {
  let c: Classes
  beforeAll(async () => {
    c = await openClasses(12)
  }, 60_000)
  afterAll(async () => {
    await c?.store.close()
  })

  const ledgerOf = (s: Spent) => ({
    answer: s.answer,
    compares: s.compares.map((x) => [x.rounds, codePoints(x.candidate)]),
    md5: s.md5,
    hmac: s.hmac,
    hashes: s.hashes,
  })

  it('AC-5: with the window open at maxCost 12, a right password spends only its own check: a native row one compare and no hash; a legacy row its own check plus one hash for the upgrade', async () => {
    const native = `native-${randomUUID().slice(0, 8)}@work.test`
    await c.open.register({ email: native, password: 'native-correct-horse' })
    const phpass = vector('phpass ascii')
    const wp10 = vector('wp bcrypt 10 ascii')
    const plain = vector('bcrypt 10 ascii')
    const wp12 = vector('wp bcrypt 12 ascii')
    const cases: Array<[string, string, string]> = [
      ['native', native, 'native-correct-horse'],
      ['$P$B', await c.legacy(phpass.hash), phpass.password],
      ['$wp$2y$10$', await c.legacy(wp10.hash), wp10.password],
      ['$2y$10$', await c.legacy(plain.hash), plain.password],
      ['$wp$2y$12$', await c.legacy(wp12.hash), wp12.password],
    ]
    const got: Array<[string, ReturnType<typeof ledgerOf>]> = []
    for (const [name, email, password] of cases) {
      got.push([name, ledgerOf(await spent(() => c.open.login(email, password)))])
    }
    const signedIn = { answer: 'signed in' }
    expect(got).toEqual([
      [
        'native',
        {
          ...signedIn,
          compares: [[10, codePoints('native-correct-horse')]],
          md5: 0,
          hmac: 0,
          hashes: 0,
        },
      ],
      ['$P$B', { ...signedIn, compares: [], md5: PHPASS_DIGESTS, hmac: 0, hashes: 1 }],
      [
        '$wp$2y$10$',
        { ...signedIn, compares: [[10, HMAC_BASE64_LENGTH]], md5: 0, hmac: 1, hashes: 1 },
      ],
      [
        '$2y$10$',
        { ...signedIn, compares: [[10, codePoints(plain.password)]], md5: 0, hmac: 0, hashes: 1 },
      ],
      [
        '$wp$2y$12$',
        { ...signedIn, compares: [[12, HMAC_BASE64_LENGTH]], md5: 0, hmac: 1, hashes: 1 },
      ],
    ])
  }, 60_000)
})
