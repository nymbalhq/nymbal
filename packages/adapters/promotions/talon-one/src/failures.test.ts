import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  closedBaseUrl,
  FAKE_TALON_ONE_API_KEY,
  startFakeTalonOne,
  type FakeAnswer,
  type FakeTalonOne,
} from './tests/fake-talon-one.js'
import { outcomeOf, recordingLogger, session, stringsIn, talonOne } from './tests/support.js'

// Every way Talon.One can fail an evaluation is a rejection the kernel reads as an outage, never "no discount": a
// refused key, a busy session, a server error, an answer that is not one, no answer in time, nothing listening. The
// API key appears in no error and no log line; a session in another currency is refused before anything is sent.

const TIMEOUT_MS = 200

let fake: FakeTalonOne
let dead: string

beforeAll(async () => {
  fake = await startFakeTalonOne()
  dead = await closedBaseUrl()
})
afterAll(async () => {
  await fake.close()
})
beforeEach(() => {
  fake.answer(null)
})

const CASES: { name: string; answer: FakeAnswer; status?: string }[] = [
  {
    name: '409 (concurrent requests on the session)',
    answer: { status: 409, body: { message: 'Conflict' } },
    status: '409',
  },
  { name: '500', answer: { status: 500, body: { message: 'Internal error' } }, status: '500' },
  { name: 'a 200 that is not JSON', answer: { status: 200, raw: '<html>maintenance</html>' } },
  {
    name: 'a 200 with no effects array',
    answer: { status: 200, body: { customerSession: { state: 'open' } } },
  },
]

describe('AC-6: a failed evaluation rejects, naming the step, and leaks no key', () => {
  it('AC-6: a wrong API key (401) rejects naming the step and the status, and no message or log line holds either key', async () => {
    const wrongKey = 'talon-wrong-key-e0d4c2b1a9'
    const { logger, lines } = recordingLogger()
    const adapter = await talonOne(fake, { apiKey: wrongKey }, logger)

    const { value, error } = await outcomeOf(() => adapter.evaluate(session(), { dry: true }))

    expect(value).toBeUndefined()
    expect(fake.requests.at(-1)!.status).toBe(401)
    expect((error as Error).message).toMatch(/evaluat/i)
    expect((error as Error).message).toMatch(/\b401\b/)
    const strings = stringsIn([error, lines])
    expect(
      strings.filter((s) => s.includes(wrongKey) || s.includes(FAKE_TALON_ONE_API_KEY)),
    ).toEqual([])
  })

  for (const c of CASES) {
    it(`AC-6: ${c.name} rejects naming the step${c.status === undefined ? '' : ' and the status'}, and no message or log line holds the key`, async () => {
      const { logger, lines } = recordingLogger()
      const adapter = await talonOne(fake, {}, logger)
      fake.answer(c.answer)

      const { value, error } = await outcomeOf(() => adapter.evaluate(session(), { dry: true }))

      expect(value).toBeUndefined()
      expect((error as Error).message).toMatch(/evaluat/i)
      // A case with no status names none; one with a status names it.
      expect((error as Error).message).toContain(c.status ?? '')
      expect(stringsIn([error, lines]).filter((s) => s.includes(FAKE_TALON_ONE_API_KEY))).toEqual(
        [],
      )
    })
  }

  it(`AC-6: a Talon.One that never answers rejects within timeoutMs (${TIMEOUT_MS} ms) plus one second, naming the step`, async () => {
    const { logger, lines } = recordingLogger()
    const adapter = await talonOne(fake, { timeoutMs: TIMEOUT_MS }, logger)
    fake.answer('hang')

    const { value, error, ms } = await outcomeOf(() => adapter.evaluate(session(), { dry: true }))

    expect(value).toBeUndefined()
    expect((error as Error).message).toMatch(/evaluat/i)
    expect(ms).toBeLessThanOrEqual(TIMEOUT_MS + 1000)
    expect(stringsIn([error, lines]).filter((s) => s.includes(FAKE_TALON_ONE_API_KEY))).toEqual([])
  })

  it('AC-6: a closed port rejects naming the step, and no message or log line holds the key', async () => {
    const { logger, lines } = recordingLogger()
    const adapter = await talonOne({ baseUrl: dead }, { timeoutMs: TIMEOUT_MS }, logger)

    const { value, error, ms } = await outcomeOf(() => adapter.evaluate(session(), { dry: true }))

    expect(value).toBeUndefined()
    expect((error as Error).message).toMatch(/evaluat/i)
    expect(ms).toBeLessThanOrEqual(TIMEOUT_MS + 1000)
    expect(stringsIn([error, lines]).filter((s) => s.includes(FAKE_TALON_ONE_API_KEY))).toEqual([])
  })

  it('AC-6: a session whose currency is not the block’s rejects and sends nothing', async () => {
    const adapter = await talonOne(fake, { currency: 'GBP' })
    const before = fake.requests.length

    const { value, error } = await outcomeOf(() =>
      adapter.evaluate(session({ currency: 'EUR' }), { dry: true }),
    )

    expect(value).toBeUndefined()
    expect(error).toBeInstanceOf(Error)
    expect(fake.requests.length).toBe(before)
  })
})
