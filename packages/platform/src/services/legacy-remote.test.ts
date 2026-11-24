import { randomBytes, randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  bodyOf,
  closedPortUrl,
  startOldPlatform,
  VALID_FALSE,
  validTrue,
  type FakeOldPlatform,
  type OldPlatformReply,
} from '../tests/old-platform.js'
import { createLogger } from '../logger.js'
import { settlesWithin } from '../tests/settles-within.js'
import {
  createOldPlatformCheck,
  REMOTE_ADDRESS_CAP,
  REMOTE_ADDRESS_WINDOW_MS,
  REMOTE_BREAKER_FAILURES,
  REMOTE_BREAKER_OPEN_MS,
  REMOTE_BREAKER_WINDOW_MS,
  REMOTE_DECOY_DEFAULT_MS,
  REMOTE_DECOY_KEEP,
  REMOTE_DECOY_MAX_AGE_MS,
  REMOTE_DECOY_SAMPLES,
  REMOTE_EMAIL_MAX_BYTES,
  REMOTE_PASSWORD_MAX_BYTES,
  type OldPlatformCheck,
  type RemoteAnswer,
} from './legacy-remote.js'

// The check a sign-in makes against the merchant's old platform, against an in-process fake of the documented
// endpoint. The clock and the random pick are injected; a duration is the injected clock's movement during a request,
// which the fake moves as each request arrives. Real time is spent only on the timeout cases (timeoutMs 500).

const SECRET = `old-platform-${randomBytes(24).toString('base64url')}`
const TIMEOUT_MS = 500
const T0 = 1_700_000_000_000

interface Rig {
  fake: FakeOldPlatform
  other: FakeOldPlatform
  closed: string
  clock: { t: number }
  rnd: { v: number }
  lines: string[]
  /** Sends the next requests to a port nothing listens on. */
  mode: { closed: boolean }
  make(): OldPlatformCheck
}

const rig = {} as Rig

beforeAll(async () => {
  rig.fake = await startOldPlatform()
  rig.other = await startOldPlatform('/elsewhere')
  rig.closed = await closedPortUrl()
  rig.clock = { t: T0 }
  rig.rnd = { v: 0 }
  rig.lines = []
  rig.mode = { closed: false }
  const logger = createLogger({
    pretty: false,
    level: 'trace',
    destination: { write: (line: string) => void rig.lines.push(line) },
  })
  rig.make = () =>
    createOldPlatformCheck({
      url: rig.fake.url,
      secret: SECRET,
      logger,
      timeoutMs: TIMEOUT_MS,
      now: () => rig.clock.t,
      random: () => rig.rnd.v,
      fetch: ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        globalThis.fetch(rig.mode.closed ? rig.closed : input, init)) as typeof fetch,
    })
})

afterAll(async () => {
  await rig.fake?.close()
  await rig.other?.close()
})

beforeEach(() => {
  rig.fake.requests.splice(0)
  rig.other.requests.splice(0)
  rig.fake.reply = () => VALID_FALSE
  rig.fake.onRequest = () => undefined
  rig.fake.hold.release()
  rig.clock.t = T0
  rig.rnd.v = 0
  rig.mode.closed = false
})

let seq = 0
const fresh = (tag = 'shopper'): string =>
  `${tag}-${(seq += 1)}-${randomUUID().slice(0, 6)}@old.test`

const label = (a: RemoteAnswer): string => (a.status === 'skipped' ? `skipped: ${a.why}` : a.status)

const emailsAsked = (): unknown[] =>
  rig.fake.requests.map((r) => (bodyOf(r) as { email?: unknown } | undefined)?.email)

const warnLines = (from: number): string[] =>
  rig.lines.slice(from).filter((l) => (JSON.parse(l) as { level: number }).level === 40)

type Failure = 'timeout' | 'closed' | 'not json' | 'no boolean valid' | number

/** One check for a fresh address, answered as `kind`: a status, a hang past the timeout, or a closed port. */
async function failWith(check: OldPlatformCheck, kind: Failure): Promise<string> {
  rig.mode.closed = kind === 'closed'
  rig.fake.reply = (): OldPlatformReply => {
    if (kind === 'timeout') return 'hang'
    if (kind === 'not json')
      return { status: 200, text: '<html>ok</html>', headers: { 'content-type': 'text/html' } }
    if (kind === 'no boolean valid') return { status: 200, json: { valid: 'true' } }
    if (kind === 302) return { status: 302, headers: { location: rig.other.url } }
    return { status: kind as number, json: { error: 'no' } }
  }
  try {
    return label(await check.check(fresh('failing'), 'a-password'))
  } finally {
    rig.mode.closed = false
    rig.fake.reply = () => VALID_FALSE
  }
}

/** One check for a fresh address the fake answers `valid: false`; what it answered and whether the fake saw it. */
async function probe(check: OldPlatformCheck): Promise<[string, boolean]> {
  const email = fresh('probe')
  const before = rig.fake.requests.length
  const answer = label(await check.check(email, 'a-password'))
  const seen = rig.fake.requests
    .slice(before)
    .some((r) => (bodyOf(r) as { email?: string }).email === email)
  return [answer, seen]
}

describe('AC-1: the request and the answer', () => {
  it('AC-1: a check sends one POST to the URL with the bearer and JSON { email lowercased, password as typed, spaces kept }, and answers ok with the profile for valid: true and bad for valid: false', async () => {
    const check = rig.make()
    const typed = `Ada.Shopper-${randomUUID().slice(0, 6)}@Old.Example`
    const password = '  correct horse  battery '
    rig.fake.reply = () =>
      validTrue({ firstName: 'Ada', lastName: 'Lovelace', phone: '+44 20 7946 0000' })
    const ok = await check.check(typed, password)
    rig.fake.reply = () => VALID_FALSE
    const bad = await check.check('bob@old.example', 'wrong one')

    expect(
      rig.fake.requests.map((r) => ({
        method: r.method,
        path: r.path,
        authorization: r.headers.authorization,
        contentType: r.headers['content-type']?.split(';')[0],
        body: bodyOf(r),
      })),
    ).toEqual([
      {
        method: 'POST',
        path: new URL(rig.fake.url).pathname,
        authorization: `Bearer ${SECRET}`,
        contentType: 'application/json',
        body: { email: typed.toLowerCase(), password },
      },
      {
        method: 'POST',
        path: new URL(rig.fake.url).pathname,
        authorization: `Bearer ${SECRET}`,
        contentType: 'application/json',
        body: { email: 'bob@old.example', password: 'wrong one' },
      },
    ])
    expect([ok, bad]).toEqual([
      {
        status: 'ok',
        profile: { firstName: 'Ada', lastName: 'Lovelace', phone: '+44 20 7946 0000' },
      },
      { status: 'bad' },
    ])
  })

  it('AC-1: a profile field that is a number, or 201 characters, is absent from the answer; 200 characters is kept; extra fields are ignored', async () => {
    const check = rig.make()
    const answers: RemoteAnswer[] = []
    for (const customer of [
      { firstName: 'f'.repeat(200), lastName: 'l'.repeat(201), phone: 4420, roles: ['admin'] },
      { firstName: 7, lastName: 'Hopper', phone: 'p'.repeat(201), email: 'other@old.test' },
    ]) {
      rig.fake.reply = () => ({ status: 200, json: { valid: true, customer, admin: true } })
      answers.push(await check.check(fresh(), 'a-password'))
    }
    rig.fake.reply = () => validTrue()
    answers.push(await check.check(fresh(), 'a-password'))
    expect(answers).toEqual([
      { status: 'ok', profile: { firstName: 'f'.repeat(200) } },
      { status: 'ok', profile: { lastName: 'Hopper' } },
      { status: 'ok', profile: {} },
    ])
  })
})

describe('AC-2: anything outside the contract is unavailable', () => {
  it('AC-2: a 500, 503, 429, 400, 401, 403, 413, a 200 not JSON, a 200 with no boolean valid, a hang, a closed port and a 302 each answer unavailable, the hang within timeoutMs plus one second, and the redirect target receives nothing; no log line holds the email, the password or the secret', async () => {
    const from = rig.lines.length
    const email = `Secret.Shopper-${randomUUID().slice(0, 8)}@Old.Example`
    const password = `pässword ${randomUUID()}`
    const kinds: Failure[] = [
      500,
      503,
      429,
      400,
      401,
      403,
      413,
      'not json',
      'no boolean valid',
      'timeout',
      'closed',
      302,
    ]
    const got: Array<[Failure, RemoteAnswer]> = []
    let hangMs = Number.NaN
    for (const kind of kinds) {
      // A check of its own per case, so the counting failures before it do not open the breaker.
      const check = rig.make()
      rig.mode.closed = kind === 'closed'
      rig.fake.reply = (): OldPlatformReply => {
        if (kind === 'timeout') return 'hang'
        if (kind === 'not json') return { status: 200, text: 'valid=true' }
        if (kind === 'no boolean valid') return { status: 200, json: { valid: 'true' } }
        if (kind === 302) return { status: 302, headers: { location: rig.other.url } }
        return { status: kind as number, json: { valid: true } }
      }
      const started = performance.now()
      got.push([kind, await check.check(email, password)])
      if (kind === 'timeout') hangMs = performance.now() - started
      rig.mode.closed = false
    }
    // AC-1's calls, through the same logger.
    const check = rig.make()
    rig.fake.reply = () => validTrue({ firstName: 'Ada' })
    await check.check(email, password)
    rig.fake.reply = () => VALID_FALSE
    await check.check(email, password)

    expect(got).toEqual(kinds.map((kind) => [kind, { status: 'unavailable' }]))
    expect(hangMs).toBeLessThan(TIMEOUT_MS + 1_000)
    expect(rig.other.requests).toEqual([])
    const secrets = [email, email.toLowerCase(), password, SECRET]
    const lines = rig.lines.slice(from)
    expect(secrets.filter((s) => lines.some((l) => l.includes(s)))).toEqual([])
  }, 15_000)
})

describe('AC-3: the per-address cap', () => {
  const W = REMOTE_ADDRESS_WINDOW_MS

  it('AC-3: property: for any interleaving of checks over up to four addresses inside the window, an address’s sixth check answers skipped: cap and is not sent, others are unaffected, case does not reset the count, and each address’s first check after the window is sent', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            who: fc.integer({ min: 0, max: 3 }),
            upper: fc.boolean(),
            dt: fc.integer({ min: 0, max: Math.floor(W / 30) }),
          }),
          { minLength: 1, maxLength: 24 },
        ),
        async (steps) => {
          rig.fake.requests.splice(0)
          rig.clock.t = T0
          const check = rig.make()
          const run = randomUUID().slice(0, 6)
          const base = [0, 1, 2, 3].map((i) => `cap${i}-${run}@x.test`)
          const counts = new Map<number, number>()
          const firsts = new Map<number, number>()
          const expected: string[] = []
          const expectedSent: string[] = []
          const got: string[] = []
          for (const step of steps) {
            rig.clock.t += step.dt
            if (!firsts.has(step.who)) firsts.set(step.who, rig.clock.t)
            const k = (counts.get(step.who) ?? 0) + 1
            counts.set(step.who, k)
            const email = step.upper ? base[step.who]!.toUpperCase() : base[step.who]!
            got.push(label(await check.check(email, 'a-password')))
            expected.push(k <= REMOTE_ADDRESS_CAP ? 'bad' : 'skipped: cap')
            if (k <= REMOTE_ADDRESS_CAP) expectedSent.push(base[step.who]!)
          }
          expect(got).toEqual(expected)
          expect(emailsAsked()).toEqual(expectedSent)

          rig.clock.t = Math.max(...firsts.values()) + W + 1
          const after: Array<[string, string]> = []
          for (const who of firsts.keys()) {
            after.push([base[who]!, label(await check.check(base[who]!, 'a-password'))])
          }
          expect(after).toEqual([...firsts.keys()].map((who) => [base[who]!, 'bad']))
          expect(emailsAsked().slice(expectedSent.length)).toEqual(
            [...firsts.keys()].map((who) => base[who]!),
          )
        },
      ),
      { numRuns: 30 },
    )
  }, 30_000)

  it('AC-3: A@x.test and a@x.test share one count: three of each, and the sixth answers skipped: cap', async () => {
    const check = rig.make()
    const got: string[] = []
    for (const email of ['A@x.test', 'a@x.test', 'A@X.TEST', 'a@x.test', 'A@x.test', 'a@X.test']) {
      got.push(label(await check.check(email, 'a-password')))
    }
    expect(got).toEqual([...Array<string>(REMOTE_ADDRESS_CAP).fill('bad'), 'skipped: cap'])
    expect(emailsAsked()).toEqual(Array<string>(REMOTE_ADDRESS_CAP).fill('a@x.test'))
  })

  it('AC-3: six checks for one address started before any answers: the fake receives five, and the sixth answers skipped: cap', async () => {
    const check = rig.make()
    rig.fake.hold.hold()
    const email = fresh('concurrent')
    const checks = Array.from({ length: REMOTE_ADDRESS_CAP + 1 }, () =>
      check.check(email, 'a-password'),
    )
    await rig.fake.hold.waiting(REMOTE_ADDRESS_CAP)
    // A cap taken after the await lets the sixth through to the fake, where it waits too.
    const sixthSettled = await settlesWithin(checks[REMOTE_ADDRESS_CAP]!, 1_000)
    rig.fake.hold.release()
    const answers = (await Promise.all(checks)).map(label)
    expect([sixthSettled, rig.fake.requests.length]).toEqual(['resolved', REMOTE_ADDRESS_CAP])
    expect(answers).toEqual([...Array<string>(REMOTE_ADDRESS_CAP).fill('bad'), 'skipped: cap'])
  })
})

describe('AC-4: the breaker', () => {
  it('AC-4: five counting failures (timeout, closed port, 500, 503, 429) inside the window open it: the next check for any address answers skipped: breaker with no request, and one warn naming no address is logged', async () => {
    const from = rig.lines.length
    const check = rig.make()
    const failures: string[] = []
    for (const kind of ['timeout', 'closed', 500, 503, 429] as const) {
      failures.push(await failWith(check, kind))
    }
    const sentBefore = rig.fake.requests.length
    const next = [await probe(check), await probe(check)]
    const warns = warnLines(from)
    expect(failures).toEqual(Array<string>(REMOTE_BREAKER_FAILURES).fill('unavailable'))
    expect(next).toEqual([
      ['skipped: breaker', false],
      ['skipped: breaker', false],
    ])
    expect(rig.fake.requests.length).toBe(sentBefore)
    expect(warns).toHaveLength(1)
    const asked = rig.fake.requests.map((r) => (bodyOf(r) as { email: string }).email)
    expect(asked.filter((email) => warns[0]!.includes(email))).toEqual([])
  }, 10_000)

  it('AC-4: four failures and then one more after the window do not open it', async () => {
    const check = rig.make()
    const failures: string[] = []
    for (let i = 0; i < REMOTE_BREAKER_FAILURES - 1; i += 1)
      failures.push(await failWith(check, 500))
    rig.clock.t += REMOTE_BREAKER_WINDOW_MS + 1
    failures.push(await failWith(check, 503))
    expect(failures).toEqual(Array<string>(REMOTE_BREAKER_FAILURES).fill('unavailable'))
    expect(await probe(check)).toEqual(['bad', true])
  })

  it('AC-4: five each of 400, 401, 403, 413, a 302 and a 200 outside the contract do not open it', async () => {
    const got: Array<[Failure, string[], [string, boolean]]> = []
    for (const kind of [400, 401, 403, 413, 302, 'no boolean valid'] as const) {
      const check = rig.make()
      const answers: string[] = []
      for (let i = 0; i < REMOTE_BREAKER_FAILURES; i += 1) answers.push(await failWith(check, kind))
      got.push([kind, answers, await probe(check)])
    }
    expect(got).toEqual(
      ([400, 401, 403, 413, 302, 'no boolean valid'] as const).map((kind) => [
        kind,
        Array<string>(REMOTE_BREAKER_FAILURES).fill('unavailable'),
        ['bad', true],
      ]),
    )
  })

  it('AC-4: bad answers never count: four failures and six bad answers leave it closed', async () => {
    const check = rig.make()
    for (let i = 0; i < REMOTE_BREAKER_FAILURES - 1; i += 1) await failWith(check, 500)
    const bads: Array<[string, boolean]> = []
    for (let i = 0; i < 6; i += 1) bads.push(await probe(check))
    expect(bads).toEqual(Array.from({ length: 6 }, () => ['bad', true]))
    expect(await probe(check)).toEqual(['bad', true])
  })

  it('AC-4: open until REMOTE_BREAKER_OPEN_MS after opening, then a check is sent, the count starts again, and five further failures open it again with a second warn', async () => {
    const from = rig.lines.length
    const check = rig.make()
    for (let i = 0; i < REMOTE_BREAKER_FAILURES; i += 1) await failWith(check, 503)
    const openedAt = rig.clock.t
    rig.clock.t = openedAt + REMOTE_BREAKER_OPEN_MS - 1
    const stillOpen = await probe(check)
    rig.clock.t = openedAt + REMOTE_BREAKER_OPEN_MS
    const closedAgain = await probe(check)
    for (let i = 0; i < REMOTE_BREAKER_FAILURES - 1; i += 1) await failWith(check, 500)
    const afterFour = await probe(check)
    await failWith(check, 429)
    const reopened = await probe(check)
    expect([stillOpen, closedAgain, afterFour, reopened]).toEqual([
      ['skipped: breaker', false],
      ['bad', true],
      ['bad', true],
      ['skipped: breaker', false],
    ])
    expect(warnLines(from)).toHaveLength(2)
  })
})

describe('AC-5: the decoy wait', () => {
  /** Every value decoyMs() answers as the injected random moves across [0, 1), sorted. */
  function picks(check: OldPlatformCheck): number[] {
    const seen = new Set<number>()
    for (let i = 0; i < 400; i += 1) {
      rig.rnd.v = i / 400
      seen.add(check.decoyMs())
    }
    return [...seen].sort((a, b) => a - b)
  }
  const sorted = (xs: number[]): number[] => [...xs].sort((a, b) => a - b)

  /** One check for `email` the old platform answers in `ms` (on the injected clock), `ok` or `bad`. */
  async function answeredIn(
    check: OldPlatformCheck,
    ms: number,
    ok: boolean,
    email = fresh('sample'),
  ) {
    rig.fake.onRequest = () => {
      rig.clock.t += ms
    }
    rig.fake.reply = () => (ok ? validTrue({ firstName: 'S' }) : VALID_FALSE)
    try {
      return label(await check.check(email, 'a-password'))
    } finally {
      rig.fake.onRequest = () => undefined
      rig.fake.reply = () => VALID_FALSE
    }
  }

  it('AC-5: REMOTE_DECOY_DEFAULT_MS before any sample; after n answered requests, one of the last min(n, REMOTE_DECOY_SAMPLES) durations, the one random picks', async () => {
    const check = rig.make()
    const before = picks(check)
    const durations: number[] = []
    const got: Array<[number, number[]]> = []
    for (let n = 1; n <= REMOTE_DECOY_SAMPLES + 5; n += 1) {
      const ms = 1_000 + 37 * n
      expect(await answeredIn(check, ms, n % 2 === 0)).toBe(n % 2 === 0 ? 'ok' : 'bad')
      durations.push(ms)
      got.push([n, picks(check)])
    }
    expect(before).toEqual([REMOTE_DECOY_DEFAULT_MS])
    expect(got).toEqual(
      durations.map((_, i) => [
        i + 1,
        sorted(durations.slice(0, i + 1).slice(-REMOTE_DECOY_SAMPLES)),
      ]),
    )
  })

  it('AC-5: a skipped check (input, cap) and an unavailable request (a timeout, a 500, a 400) add no sample', async () => {
    const check = rig.make()
    const capped = fresh('capped')
    for (let i = 0; i < REMOTE_ADDRESS_CAP; i += 1)
      await answeredIn(check, 2_000 + i, false, capped)
    const before = picks(check)
    const after: Array<[string, string, number[]]> = []
    const slow = (ms: number) => () => {
      rig.clock.t += ms
    }
    rig.fake.onRequest = slow(9_000)
    after.push(['no @', label(await check.check('nobody.x.test', 'a-password')), picks(check)])
    after.push(['capped', label(await check.check(capped, 'a-password')), picks(check)])
    after.push(['timeout', await failWith(check, 'timeout'), picks(check)])
    rig.fake.onRequest = slow(8_000)
    after.push(['500', await failWith(check, 500), picks(check)])
    rig.fake.onRequest = slow(7_000)
    after.push(['400', await failWith(check, 400), picks(check)])
    expect(before).toEqual([2_000, 2_001, 2_002, 2_003, 2_004])
    expect(after).toEqual([
      ['no @', 'skipped: input', before],
      ['capped', 'skipped: cap', before],
      ['timeout', 'unavailable', before],
      ['500', 'unavailable', before],
      ['400', 'unavailable', before],
    ])
  }, 10_000)

  it('AC-5: past REMOTE_DECOY_MAX_AGE_MS after seven samples the two oldest are no longer picked and the newest REMOTE_DECOY_KEEP still are; fresher answers replace aged ones; the default never comes back', async () => {
    const check = rig.make()
    const old = [3_001, 3_002, 3_003, 3_004, 3_005, 3_006, 3_007]
    for (const ms of old) await answeredIn(check, ms, true)
    rig.clock.t += REMOTE_DECOY_MAX_AGE_MS + 60_000
    const aged = picks(check)
    const freshMs = [450, 460]
    for (const ms of freshMs) await answeredIn(check, ms, false)
    const replaced = picks(check)
    rig.clock.t += 10 * 365 * 24 * 60 * 60_000
    const quiet = picks(check)
    expect(aged).toEqual(old.slice(-REMOTE_DECOY_KEEP))
    expect(replaced).toEqual(sorted([...old, ...freshMs].slice(-REMOTE_DECOY_KEEP)))
    expect(quiet).toEqual(replaced)
  })

  it('AC-5: after one answered request the newest sample is picked however long the clock moves, never REMOTE_DECOY_DEFAULT_MS again', async () => {
    const check = rig.make()
    const before = picks(check)
    await answeredIn(check, 777, false)
    const got: number[][] = []
    for (const years of [0, 1, 10, 100]) {
      rig.clock.t += years * 365 * 24 * 60 * 60_000 + REMOTE_DECOY_MAX_AGE_MS
      got.push(picks(check))
    }
    expect(before).toEqual([REMOTE_DECOY_DEFAULT_MS])
    expect(got).toEqual([[777], [777], [777], [777]])
  })
})

describe('AC-15: input, before anything is counted', () => {
  const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')
  /** `a@` and a domain padded to `n` bytes once lowercased, `fill` repeated first. */
  const addressOf = (n: number, fill = ''): string => {
    const head = `a@${fill}`
    return `${head}${'x'.repeat(n - bytes(head) - bytes('.test'))}.test`
  }
  const over = {
    ascii: addressOf(REMOTE_EMAIL_MAX_BYTES + 1),
    multibyte: addressOf(REMOTE_EMAIL_MAX_BYTES + 1, 'é'.repeat(100)),
    upper: addressOf(REMOTE_EMAIL_MAX_BYTES + 1).toUpperCase(),
    // U+0130 is 2 bytes and lowercases to 3: under the limit as typed, over it as sent.
    grows: (() => {
      const typed = `a@${'İ'.repeat(50)}`
      const lowered = bytes(typed.toLowerCase())
      return `${typed}${'x'.repeat(REMOTE_EMAIL_MAX_BYTES + 1 - lowered - bytes('.test'))}.test`
    })(),
  }
  // U+212A (Kelvin) is 3 bytes and lowercases to 1: over the limit as typed, under it as sent.
  const shrinks = `a@${'K'.repeat(3)}${'x'.repeat(REMOTE_EMAIL_MAX_BYTES - 2 - 3 - 5)}.test`
  const atLimit = addressOf(REMOTE_EMAIL_MAX_BYTES)
  const longPassword = `${'é'.repeat(REMOTE_PASSWORD_MAX_BYTES / 2)}x`
  const limitPassword = 'é'.repeat(REMOTE_PASSWORD_MAX_BYTES / 2)

  it('AC-15: no @, a space around the address, an address over REMOTE_EMAIL_MAX_BYTES once lowercased and a password over REMOTE_PASSWORD_MAX_BYTES each answer skipped: input with no request; at the limits they are sent as typed', async () => {
    const check = rig.make()
    const refused: Array<[string, string]> = [
      ['nobody.x.test', 'a-password'],
      [' a@x.test', 'a-password'],
      ['a@x.test ', 'a-password'],
      [over.ascii, 'a-password'],
      [over.multibyte, 'a-password'],
      [over.upper, 'a-password'],
      [over.grows, 'a-password'],
      ['a@x.test', longPassword],
    ]
    const got: string[] = []
    for (const [email, password] of refused) got.push(label(await check.check(email, password)))
    const askedBefore = rig.fake.requests.length
    const sent = [
      label(await check.check(atLimit, 'a-password')),
      label(await check.check(shrinks, 'a-password')),
      label(await check.check('b@x.test', limitPassword)),
    ]
    expect([
      bytes(over.ascii),
      bytes(over.multibyte),
      bytes(over.upper.toLowerCase()),
      bytes(over.grows.toLowerCase()),
      bytes(over.grows) <= REMOTE_EMAIL_MAX_BYTES,
      bytes(shrinks) > REMOTE_EMAIL_MAX_BYTES,
      bytes(longPassword),
      longPassword.length <= REMOTE_PASSWORD_MAX_BYTES + 1,
    ]).toEqual([255, 255, 255, 255, true, true, 257, true])
    expect([got, askedBefore]).toEqual([refused.map(() => 'skipped: input'), 0])
    expect(sent).toEqual(['bad', 'bad', 'bad'])
    expect(rig.fake.requests.map(bodyOf)).toEqual([
      { email: atLimit, password: 'a-password' },
      { email: shrinks.toLowerCase(), password: 'a-password' },
      { email: 'b@x.test', password: limitPassword },
    ])
  })

  it('AC-15: refused input spends no cap slot, counts toward no breaker and adds no sample: five sends for that address still go out afterwards', async () => {
    const check = rig.make()
    const email = fresh('input')
    const refused: Array<[string, string]> = [
      [email, longPassword],
      [` ${email}`, 'a-password'],
      [`${email} `, 'a-password'],
      [email.replace('@', '.'), 'a-password'],
    ]
    const got: string[] = []
    for (let round = 0; round < REMOTE_ADDRESS_CAP + 1; round += 1) {
      for (const [e, p] of refused) {
        rig.clock.t += 1_000
        got.push(label(await check.check(e, p)))
      }
    }
    const decoyAfterRefused = check.decoyMs()
    const sends: string[] = []
    for (let i = 0; i < REMOTE_ADDRESS_CAP; i += 1)
      sends.push(label(await check.check(email, 'a-password')))
    expect(got).toEqual(
      Array<string>(refused.length * (REMOTE_ADDRESS_CAP + 1)).fill('skipped: input'),
    )
    expect(decoyAfterRefused).toBe(REMOTE_DECOY_DEFAULT_MS)
    expect(sends).toEqual(Array<string>(REMOTE_ADDRESS_CAP).fill('bad'))
    expect(emailsAsked()).toEqual(Array<string>(REMOTE_ADDRESS_CAP).fill(email))
  })
})
