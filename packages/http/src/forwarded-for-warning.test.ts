import { afterEach, describe, expect, it } from 'vitest'
import { securitySchema } from '@nymbalhq/config'
import type { Logger } from '@nymbalhq/types'
import { FastifyHttpAdapter } from './fastify-adapter.js'

// Behind a reverse proxy with no hop trusted, every shopper is the proxy's address and shares its rate-limit buckets.
// The adapter cannot know that at boot, so the first request that carries X-Forwarded-For while no hop count was set
// logs one warn naming the variable that fixes it. An explicit 0 says no proxy is in front, and stays silent. The
// warning changes no answer.

const VARIABLE = 'NYMBAL_TRUST_PROXY_HOPS'

interface Logged {
  level: string
  args: unknown[]
}

function recordingLogger(): { logger: Logger; logged: Logged[] } {
  const logged: Logged[] = []
  const at =
    (level: string) =>
    (...args: unknown[]) => {
      logged.push({ level, args })
    }
  const logger = {
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: () => logger,
  } as unknown as Logger
  return { logger, logged }
}

/** The warns that carry `variable: NYMBAL_TRUST_PROXY_HOPS` in their fields. */
function proxyWarns(logged: Logged[]): Logged[] {
  return logged.filter(
    (entry) =>
      entry.level === 'warn' &&
      entry.args.some(
        (arg) =>
          typeof arg === 'object' &&
          arg !== null &&
          (arg as { variable?: unknown }).variable === VARIABLE,
      ),
  )
}

const open: FastifyHttpAdapter[] = []
afterEach(async () => {
  for (const adapter of open.splice(0)) await adapter.stop().catch(() => {})
})

/** A served adapter with `trustProxy` as given (absent when undefined) and one route that answers. */
async function serve(trustProxy: boolean | number | undefined) {
  const { logger, logged } = recordingLogger()
  const adapter = new FastifyHttpAdapter({
    logger,
    security: securitySchema.parse({ adapter: 'middleware', csrf: false }),
    ...(trustProxy !== undefined && { trustProxy }),
  })
  adapter.registerRoute('GET', '/api/ping', async () => ({ status: 200, body: { ok: true } }))
  adapter.registerRoute('POST', '/api/echo', async (ctx) => ({ status: 201, body: ctx.body }))
  await adapter.start(0, '127.0.0.1')
  open.push(adapter)
  const base = `http://127.0.0.1:${adapter.boundPort}`
  return {
    logged,
    /** Three requests, each with `headers`: their statuses and bodies. */
    async three(headers: Record<string, string>): Promise<string[]> {
      const out: string[] = []
      for (const [method, path, body] of [
        ['GET', '/api/ping', undefined],
        ['POST', '/api/echo', '{"n":1}'],
        ['GET', '/api/ping', undefined],
      ] as const) {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: {
            ...headers,
            ...(body !== undefined && { 'content-type': 'application/json' }),
          },
          ...(body !== undefined && { body }),
        })
        out.push(`${res.status} ${await res.text()}`)
      }
      return out
    },
  }
}

const FORWARDED = { 'x-forwarded-for': '203.0.113.7' }

describe('AC-5: X-Forwarded-For with no hop trusted warns once', () => {
  for (const [label, trustProxy] of [
    ['omitted', undefined],
    ['false', false],
  ] as const) {
    it(`AC-5: with trustProxy ${label}, three requests carrying X-Forwarded-For log exactly one warn naming ${VARIABLE}, and answer as the same requests without the header`, async () => {
      const plain = await serve(trustProxy)
      const forwarded = await serve(trustProxy)

      const withoutHeader = await plain.three({})
      const withHeader = await forwarded.three(FORWARDED)

      expect(proxyWarns(plain.logged)).toEqual([])
      expect(proxyWarns(forwarded.logged).length).toBe(1)
      expect(proxyWarns(forwarded.logged).length).toBe(proxyWarns(plain.logged).length + 1)
      expect(withHeader).toEqual(withoutHeader)
    })
  }

  it('AC-5: with trustProxy 1, or an explicit 0, three requests carrying X-Forwarded-For log no such warn', async () => {
    const oneHop = await serve(1)
    const zero = await serve(0)
    const unset = await serve(undefined)

    await oneHop.three(FORWARDED)
    await zero.three(FORWARDED)
    await unset.three(FORWARDED)

    expect(proxyWarns(oneHop.logged)).toEqual([])
    expect(proxyWarns(zero.logged)).toEqual([])
    // The unset default on the same requests does warn, so the silence above is the setting's.
    expect(proxyWarns(unset.logged).length).toBe(1)
  })
})
