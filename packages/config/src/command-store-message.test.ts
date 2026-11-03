import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { COMMAND_STORES } from './known-infrastructure.js'
import { nymbalConfigSchema, type NymbalConfigInput } from './schema.js'

// AC-7: an unknown command store is refused with a message that names the value given and the values there are, at
// the key's path; Zod's own default names neither.

function configWith(commandStore: string): Record<string, unknown> {
  const config: NymbalConfigInput = {
    store: { name: 'Test', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: { adapter: 'middleware', rateLimit: {}, csrf: true },
    commerce: {
      payments: { provider: 'stripe', config: { secretKey: 's', webhookSecret: 'w' } },
      email: { provider: 'native' },
      reviews: { provider: 'native' },
      search: { provider: 'native' },
      analytics: { provider: 'native' },
      shipping: { provider: 'native' },
      tax: { provider: 'native' },
      ai: { provider: 'anthropic', config: { apiKey: 'k' } },
    },
    http: { adapter: 'fastify', port: 3001, host: '0.0.0.0' },
    deployment: { strategy: 'standard' },
  }
  return {
    ...config,
    infrastructure: { ...(config.infrastructure as object), commandStore },
  }
}

/** The issues the schema raises at `infrastructure.commandStore`, as `{ path, message }`. */
function commandStoreIssues(commandStore: string): Array<{ path: string; message: string }> {
  const result = nymbalConfigSchema.safeParse(configWith(commandStore))
  if (result.success) return []
  return result.error.issues
    .map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    .filter((issue) => issue.path === 'infrastructure.commandStore')
}

describe('AC-7: an unknown commandStore names the value and the values there are', () => {
  it("AC-7: commandStore 'mysql' fails with exactly the message naming 'mysql' and 'sqlite', 'postgres', at infrastructure.commandStore", () => {
    expect(commandStoreIssues('mysql')).toEqual([
      {
        path: 'infrastructure.commandStore',
        message: "unknown commandStore 'mysql'; the commandStore values are 'sqlite', 'postgres'",
      },
    ])
  })

  it('AC-7: any value that is not a command store fails with that value and the list of command stores in the message', () => {
    const list = COMMAND_STORES.map((v) => `'${v}'`).join(', ')
    fc.assert(
      fc.property(
        fc
          .stringMatching(/^[a-z0-9-]{1,16}$/)
          .filter((v) => !(COMMAND_STORES as readonly string[]).includes(v)),
        (value) => {
          expect(commandStoreIssues(value).map((i) => i.message)).toEqual([
            `unknown commandStore '${value}'; the commandStore values are ${list}`,
          ])
        },
      ),
      { numRuns: 50 },
    )
  })
})
