import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfigInput } from './schema.js'

// AC-12: the `agents` block. A store that never mentions agents serves MCP with writes held as proposals; `writes`
// takes `proposal` or `apply` and nothing else.

function baseConfig(): NymbalConfigInput {
  return {
    store: { name: 'Test', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    } as unknown as NymbalConfigInput['infrastructure'],
    security: { adapter: 'middleware', rateLimit: {}, csrf: true },
    commerce: {
      payments: { provider: 'native' },
      email: { provider: 'native' },
      reviews: { provider: 'native' },
      search: { provider: 'native' },
      analytics: { provider: 'native' },
      shipping: { provider: 'native' },
      tax: { provider: 'native' },
      ai: { provider: 'none' },
    },
    http: { adapter: 'fastify', port: 3001, host: '127.0.0.1' },
    deployment: { strategy: 'standard' },
  }
}

const WRITES = ['proposal', 'apply'] as const

describe('AC-12: agents.mcp in the config', () => {
  it('AC-12: a config with no agents block parses to agents.mcp enabled with writes proposal', () => {
    const parsed = nymbalConfigSchema.parse(baseConfig())

    expect(parsed.agents).toEqual({ mcp: { enabled: true, writes: 'proposal' } })
  })

  it('AC-12: property: whatever part of agents.mcp a config sets is kept, and every part it leaves out takes its default', () => {
    fc.assert(
      fc.property(
        fc.option(fc.boolean(), { nil: undefined }),
        fc.option(fc.constantFrom(...WRITES), { nil: undefined }),
        (enabled, writes) => {
          const mcp = {
            ...(enabled !== undefined && { enabled }),
            ...(writes !== undefined && { writes }),
          }
          const parsed = nymbalConfigSchema.parse({ ...baseConfig(), agents: { mcp } })

          expect(parsed.agents.mcp).toEqual({
            enabled: enabled ?? true,
            writes: writes ?? 'proposal',
          })
        },
      ),
    )
  })

  it('AC-12: property: any writes other than proposal or apply is refused at agents.mcp.writes with a message naming both', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant('always'),
          fc.string().filter((s) => !(WRITES as readonly string[]).includes(s)),
        ),
        (writes) => {
          const result = nymbalConfigSchema.safeParse({
            ...baseConfig(),
            agents: { mcp: { writes } },
          })
          const issue = result.success
            ? undefined
            : result.error.issues.find((i) => i.path.join('.') === 'agents.mcp.writes')

          expect(result.success).toBe(false)
          expect(issue?.message).toMatch(/proposal/)
          expect(issue?.message).toMatch(/apply/)
        },
      ),
    )
  })
})
