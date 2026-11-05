// Reads: apps/docs/src/content/docs/**, apps/docs/astro.config.mjs, packages/platform/src/routes/schemas.ts
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { toolName } from '../../packages/platform/src/mcp/registry'
import { routeSchemas, type RouteSchema } from '../../packages/platform/src/routes/schemas'
import { ROOT } from './adapter-table'
import { linkTargets } from './doc-commands'

// AC-17: the docs page that tells a store which customer fields its assistant sends to the AI provider. Its table is
// held to the routes' own `personal` marks, so a route marked later fails here until the page names it. The links,
// anchors and private words of the page are public-docs.test.ts's, which reads every page under the docs content.

const DOCS = 'apps/docs/src/content/docs/'
const PAGE = `${DOCS}assistant-data.md`
const FIELDS = ['email', 'phone', 'address'] as const

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

/** Tool name to the customer fields its route's answer can carry, from the route table's marks. */
function marked(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const entry of Object.values(routeSchemas) as Array<
    RouteSchema & { personal?: readonly string[] }
  >) {
    if (entry.tool === false || entry.personal === undefined || entry.personal.length === 0)
      continue
    out[toolName(entry.name)] = [...entry.personal].sort()
  }
  return out
}

/** The page's tool table: each row whose first cell is one backticked tool name, with the fields its other cells name. */
function tabled(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const line of text.split('\n')) {
    const cells = line.trim().startsWith('|') ? line.split('|').slice(1, -1) : []
    const tool = /^\s*`([A-Za-z0-9_-]+)`\s*$/.exec(cells[0] ?? '')?.[1]
    if (tool === undefined) continue
    const rest = cells.slice(1).join(' ').toLowerCase()
    out[tool] = FIELDS.filter((field) => new RegExp(`\\b${field}(es|s)?\\b`).test(rest)).sort()
  }
  return out
}

const pointsAtPage = (text: string): boolean =>
  linkTargets(text).some((target) => /(^|\/)assistant-data\/?(#.*)?$/.test(target))

describe('AC-17: the assistant and customer data, as the docs tell it', () => {
  it('AC-17: assistant-data.md’s table names exactly the tools whose route is marked personal, each with exactly its marked fields, and the page names agents.assistant.customerData and baseUrl', () => {
    const routes = marked()
    expect(existsSync(join(ROOT, PAGE)), `${PAGE} is missing`).toBe(true)
    const text = read(PAGE)

    expect(Object.keys(routes).length).toBeGreaterThan(0)
    expect(tabled(text)).toEqual(routes)
    expect(text).toContain('agents.assistant.customerData')
    expect(text).toContain('baseUrl')
  })

  it('AC-17: the page sits in the Guides sidebar right after agents, and agents.md and the AI row of adapters.md link to it', () => {
    const sidebar = read('apps/docs/astro.config.mjs')
    const guides = /label:\s*'Guides',\s*items:\s*\[([^\]]*)\]/.exec(sidebar)?.[1] ?? ''
    const items = [...guides.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
    const aiRow = read(`${DOCS}adapters.md`)
      .split('\n')
      .filter((line) => /^\|\s*AI\s*\|/.test(line))

    expect(items.indexOf('assistant-data')).toBe(items.indexOf('agents') + 1)
    expect(pointsAtPage(read(`${DOCS}agents.md`))).toBe(true)
    expect(aiRow.length).toBe(1)
    expect(pointsAtPage(aiRow[0]!)).toBe(true)
  })
})
