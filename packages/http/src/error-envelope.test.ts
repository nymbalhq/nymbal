import fc from 'fast-check'
import { errorCodes, type FastifyPluginAsync, type LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { securitySchema } from '@nymbalhq/config'
import { FastifyHttpAdapter } from './fastify-adapter.js'

// Every error the API answers has the platform's shape `{ error: { code, message } }` and carries x-correlation-id,
// including the ones Fastify raises before a route handler runs: a body it cannot parse, a URL it cannot decode.

const logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this
  },
}

const ECHO = '/api/echo'
const ITEM = '/api/items/:slug'
const PLUGIN_FAIL = '/plugin/fail'
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const FASTIFY_MAX_PARAM_LENGTH = 100
const FASTIFY_BODY_LIMIT = 1024 * 1024

const ran = { echo: 0, item: 0 }

let adapter: FastifyHttpAdapter

/** A plugin route that throws: the status and message come from the request, so one route serves every case. */
const failing: FastifyPluginAsync = async (app) => {
  app.get(PLUGIN_FAIL, async (req) => {
    const status = req.headers['x-fail-status']
    const err = new Error(String(req.headers['x-fail-message']))
    if (typeof status === 'string') Object.assign(err, { statusCode: Number(status) })
    throw err
  })
}

beforeAll(async () => {
  adapter = new FastifyHttpAdapter({
    logger,
    security: securitySchema.parse({ adapter: 'middleware' }),
  })
  adapter.registerRoute(
    'POST',
    ECHO,
    (ctx) => {
      ran.echo += 1
      return { status: 200, body: { got: ctx.body ?? null } }
    },
    { csrf: false },
  )
  adapter.registerRoute('GET', ITEM, (ctx) => {
    ran.item += 1
    return { status: 200, body: { slug: ctx.params['slug'] ?? null } }
  })
  adapter.registerPlugin(failing)
  await adapter.start(0, '127.0.0.1')
})

afterAll(async () => {
  await adapter?.stop()
})

const correlationId = (res: LightMyRequestResponse): unknown => res.headers['x-correlation-id']

const validInbound = fc.stringMatching(/^[A-Za-z0-9._:-]{1,128}$/)

/** The id an answer must carry: the inbound one when it is valid, else a fresh UUIDv7. */
const expectedId = (inbound: string | null): unknown => inbound ?? expect.stringMatching(UUID_V7)

describe('AC-1: a body Fastify cannot parse as JSON answers 400 in the envelope', () => {
  it('AC-1: any malformed or empty JSON body answers 400 with only the error envelope, the handler never runs, and the correlation id is the inbound one when valid', async () => {
    // ASCII strings JSON.parse rejects: secure-json-parse rejects them too (it only differs on a leading BOM).
    const malformed = fc.oneof(
      fc.constant(''),
      fc.string().filter((s) => {
        try {
          JSON.parse(s)
          return false
        } catch {
          return true
        }
      }),
    )
    await fc.assert(
      fc.asyncProperty(malformed, fc.option(validInbound, { nil: null }), async (body, inbound) => {
        const before = ran.echo
        const res = await adapter.inject({
          method: 'POST',
          url: ECHO,
          headers: {
            'content-type': 'application/json',
            ...(inbound !== null && { 'x-correlation-id': inbound }),
          },
          payload: body,
        })
        const expected =
          body.length === 0
            ? new errorCodes.FST_ERR_CTP_EMPTY_JSON_BODY()
            : new errorCodes.FST_ERR_CTP_INVALID_JSON_BODY()

        expect(res.statusCode).toBe(400)
        expect(res.headers['content-type']).toMatch(/^application\/json/)
        expect(res.json()).toEqual({ error: { code: expected.code, message: expected.message } })
        expect(ran.echo).toBe(before)
        expect(correlationId(res)).toEqual(expectedId(inbound))
      }),
      { numRuns: 40 },
    )
  })
})

describe('AC-2: a 415 and a 413 answer the envelope with their own status and code', () => {
  const cases = [
    {
      label: '415: a form-encoded body to a route that does not take raw bodies',
      contentType: 'application/x-www-form-urlencoded',
      payload: 'a=1&b=2',
      expected: new errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE('application/x-www-form-urlencoded'),
    },
    {
      label: "413: a JSON body one byte over Fastify's 1 MiB default",
      contentType: 'application/json',
      payload: `"${'a'.repeat(FASTIFY_BODY_LIMIT - 1)}"`,
      expected: new errorCodes.FST_ERR_CTP_BODY_TOO_LARGE(),
    },
  ] as const
  for (const c of cases) {
    it(`AC-2: ${c.label} answers its status with its FST_ERR_* code in the envelope`, async () => {
      const before = ran.echo
      const res = await adapter.inject({
        method: 'POST',
        url: ECHO,
        headers: { 'content-type': c.contentType },
        payload: c.payload,
      })

      expect(res.statusCode).toBe(c.expected.statusCode)
      expect(res.headers['content-type']).toMatch(/^application\/json/)
      expect(res.json()).toEqual({ error: { code: c.expected.code, message: c.expected.message } })
      expect(ran.echo).toBe(before)
      expect(correlationId(res)).toEqual(expect.stringMatching(UUID_V7))
    })
  }
})

describe('AC-3: an error raised outside a route handler answers a 5xx that hides its message', () => {
  it('AC-3: a plugin route that throws with no status or a 5xx answers that 5xx (500 when none) with code internal, and the thrown message is not in the body', async () => {
    const status = fc.option(fc.integer({ min: 500, max: 599 }), { nil: null })
    const secret = fc.stringMatching(/^[a-z0-9]{6,16}$/).map((s) => `secret-${s}`)
    await fc.assert(
      fc.asyncProperty(status, secret, async (thrownStatus, message) => {
        const res = await adapter.inject({
          method: 'GET',
          url: PLUGIN_FAIL,
          headers: {
            'x-fail-message': message,
            ...(thrownStatus !== null && { 'x-fail-status': String(thrownStatus) }),
          },
        })

        expect(res.statusCode).toBe(thrownStatus ?? 500)
        expect(res.json()).toEqual({
          error: { code: 'internal', message: 'Internal server error' },
        })
        expect(res.body.includes(message)).toBe(false)
        expect(correlationId(res)).toEqual(expect.stringMatching(UUID_V7))
      }),
      { numRuns: 30 },
    )
  })
})

describe('AC-4: a URL Fastify cannot decode answers the envelope with a correlation id', () => {
  it('AC-4: any /api/ target with a bad percent-encoding answers 400 FST_ERR_BAD_URL carrying the inbound id when valid, else a fresh UUIDv7, and no two requests share an id', async () => {
    const malformed = fc.oneof(
      fc.constantFrom('/api/%E0%A4%A', '/api/%zz'),
      fc
        .tuple(
          fc.stringMatching(/^[a-z0-9-]{0,8}(\/[a-z0-9-]{1,8}){0,2}$/),
          fc.constantFrom('%zz', '%g1', '%E0%A4%A', '%C3', '%FF', '%E0%A4', '%'),
        )
        .map(([path, bad]) => `/api/${path}${bad}`),
    )
    const fresh: unknown[] = []
    await fc.assert(
      fc.asyncProperty(malformed, fc.option(validInbound, { nil: null }), async (url, inbound) => {
        const res = await adapter.inject({
          method: 'GET',
          url,
          headers: inbound === null ? {} : { 'x-correlation-id': inbound },
        })

        expect(res.statusCode).toBe(400)
        expect(correlationId(res)).toEqual(expectedId(inbound))
        expect(res.headers['content-type']).toMatch(/^application\/json/)
        expect(res.json()).toEqual({
          error: { code: 'FST_ERR_BAD_URL', message: expect.any(String) },
        })
        if (inbound === null) fresh.push(correlationId(res))
      }),
      { numRuns: 40 },
    )
    // Two more without an inbound id, so the uniqueness check always has a pair to compare.
    for (const url of ['/api/%zz', '/api/%zz']) {
      fresh.push(correlationId(await adapter.inject({ method: 'GET', url })))
    }

    expect(new Set(fresh).size).toBe(fresh.length)
  })

  it("AC-4: a param one character over Fastify's default length answers 414 FST_ERR_MAX_PARAM_LENGTH with a correlation id and the handler never runs", async () => {
    const before = ran.item
    const res = await adapter.inject({
      method: 'GET',
      url: `/api/items/${'a'.repeat(FASTIFY_MAX_PARAM_LENGTH + 1)}`,
    })

    expect(res.statusCode).toBe(414)
    expect(correlationId(res)).toEqual(expect.stringMatching(UUID_V7))
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(res.json()).toEqual({
      error: { code: 'FST_ERR_MAX_PARAM_LENGTH', message: expect.any(String) },
    })
    expect(ran.item).toBe(before)
  })
})
