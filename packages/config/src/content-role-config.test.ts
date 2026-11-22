import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { CONTENT_ROLE_FIELDS, nymbalConfigSchema } from './schema.js'

// `agents.roles.content` in nymbal.config.ts: off by default, bounded in what it may propose and spend, and refused at
// load when it is switched on where it could never run (no AI provider, or the night shift off).

const DEFAULTS = {
  enabled: false,
  schedule: 'weekly',
  fields: ['seoTitle', 'seoDescription'],
  maxProducts: 20,
  maxTokensPerRun: 100_000,
}

const ANTHROPIC = { provider: 'anthropic', config: { apiKey: 'k' } }

function configWith(more: Record<string, unknown>, ai: unknown = ANTHROPIC) {
  return {
    store: { name: 'Test Store', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: { adapter: 'middleware' },
    commerce: {
      payments: { provider: 'native' },
      email: { provider: 'native' },
      reviews: { provider: 'native' },
      search: { provider: 'native' },
      analytics: { provider: 'native' },
      shipping: { provider: 'native' },
      tax: { provider: 'native' },
      ai,
    },
    http: { adapter: 'fastify', port: 3001 },
    deployment: { strategy: 'standard' },
    ...more,
  }
}

const withRole = (
  content: Record<string, unknown>,
  ai?: unknown,
  more: Record<string, unknown> = {},
) => configWith({ agents: { roles: { content } }, ...more }, ai)

/** The role block as parsed, or null when the config was refused. */
function roleOf(input: unknown): unknown {
  const result = nymbalConfigSchema.safeParse(input)
  if (!result.success) return null
  return (result.data.agents as unknown as { roles?: { content?: unknown } }).roles?.content ?? null
}

/** Every issue as one string: its path, and the keys an unknown-key issue names. */
function issuesOf(input: unknown): string[] {
  const result = nymbalConfigSchema.safeParse(input)
  if (result.success) return []
  return result.error.issues.map((issue) => {
    const keys = 'keys' in issue && Array.isArray(issue.keys) ? issue.keys : []
    return [...issue.path, ...keys].join('.')
  })
}

const refusedAt = (input: unknown, path: string) =>
  issuesOf(input).some((p) => p === path || p.startsWith(`${path}.`))

describe('AC-1: agents.roles.content config', () => {
  it('AC-1: without an agents block, a roles block or a content key the role parses to the defaults; set keys survive beside the defaults and a repeated field is kept once', () => {
    const parsed = [
      roleOf(configWith({})),
      roleOf(configWith({ agents: {} })),
      roleOf(configWith({ agents: { roles: {} } })),
      roleOf(withRole({})),
    ]
    expect(parsed).toEqual([DEFAULTS, DEFAULTS, DEFAULTS, DEFAULTS])
    expect([...CONTENT_ROLE_FIELDS]).toEqual(DEFAULTS.fields)

    expect(roleOf(withRole({ schedule: 'daily', prompt: 'Warm and plain.' }))).toEqual({
      ...DEFAULTS,
      schedule: 'daily',
      prompt: 'Warm and plain.',
    })
    expect(roleOf(withRole({ fields: ['seoTitle', 'seoTitle'] }))).toEqual({
      ...DEFAULTS,
      fields: ['seoTitle'],
    })
  })

  it('AC-1: a field outside the two, maxProducts 0 or 51, maxTokensPerRun 999, a 2001-character prompt and an unknown key are each refused at the key they name; an empty fields list is refused', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ fields: ['description'] }, 'agents.roles.content.fields'],
      [{ fields: [] }, 'agents.roles.content.fields'],
      [{ maxProducts: 0 }, 'agents.roles.content.maxProducts'],
      [{ maxProducts: 51 }, 'agents.roles.content.maxProducts'],
      [{ maxTokensPerRun: 999 }, 'agents.roles.content.maxTokensPerRun'],
      [{ prompt: 'x'.repeat(2001) }, 'agents.roles.content.prompt'],
      [{ prompt: '' }, 'agents.roles.content.prompt'],
      [{ tools: ['admin_products_update'] }, 'agents.roles.content.tools'],
    ]

    expect(cases.map(([content, path]) => refusedAt(withRole(content), path))).toEqual(
      cases.map(() => true),
    )
    expect(roleOf(withRole({ prompt: 'x'.repeat(2000), maxTokensPerRun: 1000 }))).toEqual({
      ...DEFAULTS,
      prompt: 'x'.repeat(2000),
      maxTokensPerRun: 1000,
    })
  })

  it('AC-1: property: maxProducts loads exactly when it is a whole number from 1 to 50, and maxTokensPerRun exactly when it is at least 1000', () => {
    fc.assert(
      fc.property(fc.integer({ min: -5, max: 60 }), (n) => {
        const role = roleOf(withRole({ maxProducts: n })) as { maxProducts: number } | null
        expect(role?.maxProducts ?? null).toBe(n >= 1 && n <= 50 ? n : null)
      }),
    )
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5000 }), (n) => {
        const role = roleOf(withRole({ maxTokensPerRun: n })) as { maxTokensPerRun: number } | null
        expect(role?.maxTokensPerRun ?? null).toBe(n >= 1000 ? n : null)
      }),
    )
  })

  it('AC-1: enabled: true is refused at agents.roles.content.enabled with commerce.ai none and with nightShift.enabled false, and loads with an AI provider and the night shift on', () => {
    const noProvider = withRole({ enabled: true }, { provider: 'none' })
    const noNight = withRole({ enabled: true }, ANTHROPIC, { nightShift: { enabled: false } })
    const runnable = withRole({ enabled: true }, ANTHROPIC)

    expect([
      issuesOf(noProvider).includes('agents.roles.content.enabled'),
      issuesOf(noNight).includes('agents.roles.content.enabled'),
    ]).toEqual([true, true])
    expect(roleOf(runnable)).toEqual({ ...DEFAULTS, enabled: true })
    expect(roleOf(withRole({ enabled: false }, { provider: 'none' }))).toEqual(DEFAULTS)
  })
})
