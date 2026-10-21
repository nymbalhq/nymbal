import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { renderDevSummary, type DevSummaryInfo } from './dev-summary.js'

// Acceptance test for P2-09 AC-1 (spec P2-09-dev-stage, decision 2): renderDevSummary over generated DevSummaryInfo,
// 1-12 slots with 0-20 capabilities each, long names, api-only or not, admin built or not, sqlite or a postgres URL
// with credentials and a query. The block names every slot with its provider and every primitive with its provider,
// prints the API, storefront and admin URLs verbatim, prints a postgres URL's host, port and database but never its
// username, password or query, has at most 30 lines of at most 100 columns, and a capability list cut with `…` ends
// `(+n)` where n is the count left out. Kills: a missing slot or primitive, an overflowing block, a leaked credential,
// a wrong count.
// Names are drawn from disjoint alphabets (`s-…` slots, `p-…` providers, `c<i>-…` capabilities) so a line can be matched
// to its slot by whole words without knowing the layout.

const MAX_LINES = 30
const MAX_COLUMNS = 100

const word = (prefix: string, min: number, max: number) =>
  fc.stringMatching(new RegExp(`^[a-z0-9]{${min},${max}}$`)).map((s) => `${prefix}${s}`)
const alnum = (min: number, max: number) =>
  fc.stringMatching(new RegExp(`^[A-Za-z0-9]{${min},${max}}$`))

const slotArb = fc.record({
  slot: word('s-', 3, 18),
  provider: word('p-', 3, 18),
  // `c<i>-…`: no capability is a prefix of another, so a name cut short with `…` never reads as a whole one.
  capabilities: fc
    .array(fc.stringMatching(/^[a-z0-9]{2,14}$/), { minLength: 0, maxLength: 20 })
    .map((names) => names.map((n, i) => `c${i}-${n}`)),
})

const portArb = fc.integer({ min: 1024, max: 65535 })

const postgresArb = fc.record({
  user: alnum(10, 16).map((s) => `u${s}`),
  password: alnum(14, 24).map((s) => `pw${s}`),
  host: word('db-', 4, 20).map((h) => `${h}.example.internal`),
  port: portArb,
  database: word('shop', 2, 12),
  queryValue: alnum(12, 20).map((s) => `q${s}`),
})

type Postgres = {
  user: string
  password: string
  host: string
  port: number
  database: string
  queryValue: string
}

const postgresUrl = (p: Postgres) =>
  `postgres://${p.user}:${p.password}@${p.host}:${p.port}/${p.database}?sslmode=require&sslpassword=${p.queryValue}`

const infoArb = fc
  .record({
    store: fc.stringMatching(/^[A-Za-z0-9 '&-]{1,80}$/),
    apiPort: portArb,
    storefront: fc.option(
      fc.record({ template: fc.constantFrom('astro', 'nextjs'), port: portArb }),
      { nil: null },
    ),
    adminBuilt: fc.boolean(),
    commandStore: fc.oneof(
      fc.record({
        kind: fc.constant('sqlite' as const),
        path: fc
          .array(word('d', 1, 10), { minLength: 1, maxLength: 5 })
          .map((dirs) => `/tmp/${dirs.join('/')}/nymbal.db`),
      }),
      fc.record({ kind: fc.constant('postgres' as const), pg: postgresArb }),
    ),
    slots: fc.uniqueArray(slotArb, { minLength: 1, maxLength: 12, selector: (s) => s.slot }),
    documentStore: fc.constantFrom('in-memory', 'redis', 'postgres-jsonb'),
    eventBus: fc.constantFrom('in-process', 'redis-streams'),
    media: fc.constantFrom('local-fs', 's3'),
  })
  .map((g) => {
    const apiUrl = `http://localhost:${g.apiPort}`
    const info: DevSummaryInfo = {
      store: g.store,
      apiUrl,
      storefront:
        g.storefront === null
          ? null
          : { template: g.storefront.template, url: `http://localhost:${g.storefront.port}` },
      admin: g.adminBuilt ? { url: `${apiUrl}/admin/` } : null,
      commandStore:
        g.commandStore.kind === 'sqlite'
          ? { kind: 'sqlite', path: g.commandStore.path }
          : { kind: 'postgres', url: postgresUrl(g.commandStore.pg) },
      slots: g.slots,
      primitives: [
        { name: 'documentStore', provider: g.documentStore },
        { name: 'eventBus', provider: g.eventBus },
        { name: 'media', provider: g.media },
      ],
    }
    return { info, pg: g.commandStore.kind === 'postgres' ? g.commandStore.pg : null }
  })

/** Columns as a terminal counts them for this text: one per code point (`…` is one). */
const columns = (line: string) => [...line].length
const plain = (text: string) => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')

function hasWord(line: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[\\s:,()\\[\\]|=])${escaped}($|[\\s:,()\\[\\]|=…])`).test(line)
}

describe('P2-09 AC-1: renderDevSummary', () => {
  it('AC-1: names every slot with its provider and every primitive, keeps the URLs verbatim, never prints a postgres credential or query, stays within 30 lines of 100 columns, and a cut capability list ends (+n) with the count left out', () => {
    fc.assert(
      fc.property(infoArb, ({ info, pg }) => {
        const text = plain(renderDevSummary(info))
        const lines = text.replace(/\n$/, '').split('\n')

        expect(lines.length).toBeLessThanOrEqual(MAX_LINES)
        for (const line of lines) expect(columns(line), line).toBeLessThanOrEqual(MAX_COLUMNS)

        for (const { slot, provider, capabilities } of info.slots) {
          const own = lines.filter((l) => hasWord(l, slot) && hasWord(l, provider))
          expect(own, `one line names ${slot} with ${provider}`).toHaveLength(1)
          const line = own[0]!
          const shown = line
            .split(/[\s,]+/)
            .map((t) => t.replace(/…$/, ''))
            .filter((t) => capabilities.includes(t))
          const cut = /\(\+(\d+)\)\s*$/.exec(line)
          const hidden = cut === null ? 0 : Number(cut[1])
          expect(shown, `${slot}: the shown capabilities lead the list, in order`).toEqual(
            capabilities.slice(0, shown.length),
          )
          expect(shown.length + hidden, `${slot}: shown plus (+n) is every capability`).toBe(
            capabilities.length,
          )
          expect(line.includes('…'), `${slot}: a cut list is marked with …`).toBe(hidden > 0)
        }

        for (const { name, provider } of info.primitives) {
          expect(
            lines.filter((l) => hasWord(l, name) && hasWord(l, provider)).length,
            `a line names ${name} with ${provider}`,
          ).toBeGreaterThanOrEqual(1)
        }

        const verbatim = [
          info.apiUrl,
          info.storefront?.url,
          info.admin?.url,
          info.commandStore.kind === 'sqlite' ? info.commandStore.path : undefined,
        ].filter((u): u is string => u !== undefined)
        expect(
          verbatim.filter((u) => !text.includes(u)),
          'URLs and path not printed verbatim',
        ).toEqual([])

        const shownParts = pg === null ? [] : [pg.host, String(pg.port), pg.database]
        const hiddenParts =
          pg === null ? [] : [pg.user, pg.password, pg.queryValue, 'sslmode=require']
        expect(
          shownParts.filter((p) => !text.includes(p)),
          'postgres host, port, db',
        ).toEqual([])
        expect(
          hiddenParts.filter((p) => text.includes(p)),
          'postgres credentials or query',
        ).toEqual([])
      }),
      { numRuns: 200 },
    )
  })
})
