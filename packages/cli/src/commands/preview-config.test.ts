import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  BUILT_IN,
  KNOWN_PROVIDERS,
  nymbalConfigSchema,
  type CommerceSlot,
  type NymbalConfig,
} from '@nymbalhq/config'
import { previewConfig } from './preview-config.js'

// The config a preview boots its throwaway store on, made from whatever the merchant's project configures: every
// service that could mail a customer, bill an AI key, index a catalogue, write a bucket or share a database with the
// real store is replaced by the kernel's own, so a preview reaches nothing the project reaches.

const SLOTS = Object.keys(KNOWN_PROVIDERS) as CommerceSlot[]

/** A commerce slot's block: any provider the slot lists, a third-party one, `custom`; packages and config included. */
const arbSlot = (slot: CommerceSlot) =>
  fc
    .record({
      provider: fc.constantFrom(...KNOWN_PROVIDERS[slot], 'acme'),
      withPackage: fc.boolean(),
      withConfig: fc.boolean(),
    })
    .map(({ provider, withPackage, withConfig }) => {
      const builtIn = (BUILT_IN[slot] as readonly string[]).includes(provider)
      return {
        provider,
        ...(withPackage && !builtIn && { package: `@acme/nymbal-${slot}` }),
        ...(withConfig && {
          config: { apiKey: `live-${slot}-key`, baseUrl: `https://${slot}.example` },
        }),
      }
    })

const arbInfrastructure = fc
  .record({
    commandStore: fc.constantFrom('sqlite', 'postgres'),
    documentStore: fc.constantFrom('in-memory', 'redis', 'postgres-jsonb'),
    redisBus: fc.boolean(),
    s3: fc.boolean(),
  })
  .map(({ commandStore, documentStore, redisBus, s3 }) => {
    const docs =
      documentStore === 'postgres-jsonb' && commandStore !== 'postgres' ? 'redis' : documentStore
    const bus = redisBus && docs !== 'in-memory' ? 'redis-streams' : 'in-process'
    return {
      commandStore,
      documentStore: { provider: docs },
      eventBus: { provider: bus },
      media: { provider: s3 ? 's3' : 'local-fs' },
      ...((docs === 'redis' || bus === 'redis-streams') && {
        redis: { url: 'redis://cache.internal:6379', prefix: 'shop' },
      }),
      ...(s3 && { s3: { bucket: 'shop-media', region: 'eu-west-2' } }),
    }
  })

const arbSecurity = fc.constantFrom<Record<string, unknown>>(
  { adapter: 'middleware' },
  { adapter: 'cloudflare', cloudflare: { zoneId: 'zone-1', apiToken: 'cf-token' } },
  { adapter: 'acme', package: '@acme/nymbal-security', config: { key: 'k' } },
)

/** A config the schema accepts, as `nymbal` loads it from a project. */
const arbConfig: fc.Arbitrary<NymbalConfig> = fc
  .record({
    commerce: fc.record(
      Object.fromEntries(SLOTS.map((slot) => [slot, arbSlot(slot)])) as Record<
        CommerceSlot,
        ReturnType<typeof arbSlot>
      >,
    ),
    infrastructure: arbInfrastructure,
    security: arbSecurity,
    archive: fc.boolean(),
    currency: fc.constantFrom('GBP', 'JPY', 'EUR', 'KWD'),
    template: fc.constantFrom('astro', 'nextjs'),
    url: fc.option(fc.constant('https://shop.example'), { nil: undefined }),
  })
  .map((c) =>
    nymbalConfigSchema.parse({
      store: {
        name: 'Merchant Shop',
        currency: c.currency,
        locale: 'en-GB',
        timezone: 'Europe/London',
        ...(c.url !== undefined && { url: c.url }),
      },
      template: c.template,
      infrastructure: c.infrastructure,
      security: c.security,
      commerce: c.commerce,
      http: {
        adapter: 'fastify',
        port: 8080,
        host: '0.0.0.0',
        cors: { allowedOrigins: ['https://shop.example'] },
      },
      deployment: { strategy: 'standard' },
      ...(c.archive && { events: { archive: { adapter: 's3', bucket: 'shop-event-archive' } } }),
    }),
  )

const arbOptions = fc.record({
  dir: fc.constant('/tmp/nymbal-preview-abc123'),
  apiPort: fc.integer({ min: 1024, max: 65535 }),
  storefrontOrigin: fc.option(
    fc.integer({ min: 1024, max: 65535 }).map((port) => `http://localhost:${port}`),
    { nil: null },
  ),
  ai: fc.boolean(),
})

describe('previewConfig', () => {
  it("AC-3: for generated valid configs, the preview config is valid, every commerce slot is the kernel provider with no package or config (ai kept only with ai: true), security is middleware, infrastructure is sqlite, in-memory, in-process and local-fs, there is no archive, the API listens on 127.0.0.1 at the port given with CORS for the storefront alone, store and template are the project's, and the input is unchanged", () => {
    fc.assert(
      fc.property(arbConfig, arbOptions, (config, options) => {
        const before = structuredClone(config)

        const out = previewConfig(config, options)

        const parsed = nymbalConfigSchema.safeParse(out)
        expect(parsed.success ? [] : parsed.error.issues.map((i) => i.message)).toEqual([])
        for (const slot of SLOTS) {
          const expected =
            slot === 'ai' && options.ai ? before.commerce.ai : { provider: BUILT_IN[slot][0] }
          expect([slot, out.commerce[slot]]).toEqual([slot, expected])
        }
        expect([out.security.adapter, out.security.package, out.security.config]).toEqual([
          'middleware',
          undefined,
          undefined,
        ])
        expect(out.infrastructure).toEqual({
          commandStore: 'sqlite',
          documentStore: { provider: 'in-memory' },
          eventBus: { provider: 'in-process' },
          media: { provider: 'local-fs' },
        })
        expect(out.events.archive).toBeUndefined()
        expect([out.http.host, out.http.port]).toEqual(['127.0.0.1', options.apiPort])
        const origin = options.storefrontOrigin
        expect([...out.http.cors.allowedOrigins].sort()).toEqual(
          origin === null ? [] : [origin, origin.replace('//localhost:', '//127.0.0.1:')].sort(),
        )
        expect({ store: out.store, template: out.template }).toEqual({
          store: before.store,
          template: before.template,
        })
        expect(config).toEqual(before)
      }),
      { numRuns: 200 },
    )
  })
})
