// Reads: apps/docs/src/content/docs/agents.md, apps/docs/src/content/docs/assistant-data.md, packages/config/src/schema.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CUSTOMER_FIELDS } from '../../packages/config/src/schema'
import { ROOT } from './adapter-table'

// AC-9: the docs say what an admin's MCP client is not sent, and promise no more than the store withholds: the setting
// and its default fields, both transports, the `withheld` list, the constants that replace typed emails and phones,
// how to send everything, and that a shopper's own data and the admin's assistant are not affected. The assistant-data
// page lists the order commands among the tools that send customer details, and its privacy paragraph keeps the
// assistant's placeholder sentence beside one for agents that names what is not detected. The table's equality with
// the routes' marks stays assistant-data-docs.test.ts's; links and private words stay public-docs.test.ts's.

const DOCS = 'apps/docs/src/content/docs/'
const PAGES = [`${DOCS}agents.md`, `${DOCS}assistant-data.md`] as const
const DATA_PAGE = `${DOCS}assistant-data.md`

/** The order commands whose answers carry the order, with the customer fields the table must name for each. */
const ORDER_COMMANDS: Record<string, string[]> = {
  admin_orders_confirm: ['address', 'email', 'phone'],
  admin_orders_process: ['address', 'email', 'phone'],
  admin_orders_cancel: ['address', 'email', 'phone'],
  admin_orders_markPaid: ['address', 'email', 'phone'],
  admin_orders_markDelivered: ['address', 'email', 'phone'],
  admin_orders_ship: ['address', 'email', 'phone'],
  admin_orders_refund: ['address', 'email', 'phone'],
  admin_orders_resendConfirmation: ['email'],
}

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')
const paragraphs = (text: string): string[] => text.split(/\n\s*\n/)

/** The text under the page's `## <heading>`, up to the next `## `; '' when there is none. */
function section(text: string, heading: RegExp): string {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^##\s/.test(line) && heading.test(line))
  if (start === -1) return ''
  const end = lines.findIndex((line, i) => i > start && /^##\s/.test(line))
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n')
}

/** The page's tool table: each row whose first cell is one backticked tool name, with the fields its other cells name. */
function tabled(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const line of text.split('\n')) {
    const cells = line.trim().startsWith('|') ? line.split('|').slice(1, -1) : []
    const tool = /^\s*`([A-Za-z0-9_-]+)`\s*$/.exec(cells[0] ?? '')?.[1]
    if (tool === undefined) continue
    const rest = cells.slice(1).join(' ').toLowerCase()
    out[tool] = ['address', 'email', 'phone'].filter((field) =>
      new RegExp(`\\b${field}(es|s)?\\b`).test(rest),
    )
  }
  return out
}

/** The default fields a paragraph on withholding names, in the config's order: those of the paragraph naming most. */
function namedDefaults(text: string): string[] {
  const named = paragraphs(text)
    .filter((p) => /agents\.mcp\.withhold|withh/i.test(p) && /\bdefault/i.test(p))
    .map((p) =>
      DEFAULT_CUSTOMER_FIELDS.filter((field: string) => new RegExp(`\\b${field}`, 'i').test(p)),
    )
  return named.sort((a, b) => b.length - a.length)[0] ?? []
}

/** What a page must say about agents and customer fields, each check by name, and the ones it does not say. */
function unsaid(text: string): string[] {
  const said: Record<string, boolean> = {
    'agents.mcp.withhold': text.includes('agents.mcp.withhold'),
    'POST /api/mcp': text.includes('POST /api/mcp'),
    'nymbal mcp': text.includes('nymbal mcp'),
    'the `withheld` field': text.includes('`withheld`'),
    '[email withheld]': text.includes('[email withheld]'),
    '[phone withheld]': text.includes('[phone withheld]'),
    'withhold: []': text.includes('withhold: []'),
    'a shopper’s own data is not withheld': paragraphs(text).some(
      (p) => /shopper/i.test(p) && /\bown\b/i.test(p) && /withh/i.test(p),
    ),
    'the admin’s assistant is not affected': paragraphs(text).some(
      (p) =>
        /assistant/i.test(p) && /withh/i.test(p) && /\b(not|unaffected|unchanged|still)\b/i.test(p),
    ),
  }
  return Object.entries(said)
    .filter(([, ok]) => !ok)
    .map(([name]) => name)
}

describe('AC-9: the docs say what agents are not sent', () => {
  // Kills: docs that promise placeholders while an MCP client receives values, or that leave the setting unnamed.
  it('AC-9: agents.md and assistant-data.md each name agents.mcp.withhold with its default fields, POST /api/mcp and nymbal mcp, the withheld field, [email withheld] and [phone withheld], withhold: [], and say that a shopper’s own data and the admin’s assistant are not affected', () => {
    const pages = PAGES.map((page) => ({ page, text: read(page) }))

    expect(pages.map(({ page, text }) => ({ page, unsaid: unsaid(text) }))).toEqual(
      PAGES.map((page) => ({ page, unsaid: [] })),
    )
    expect(pages.map(({ text }) => namedDefaults(text))).toEqual(
      PAGES.map(() => [...DEFAULT_CUSTOMER_FIELDS]),
    )
  })

  // Kills: a table that misses a marked order command.
  it('AC-9: assistant-data.md’s table names the eight order commands that answer the order, each with the customer fields it sends', () => {
    const table = tabled(read(DATA_PAGE))

    expect(
      Object.fromEntries(Object.keys(ORDER_COMMANDS).map((name) => [name, table[name]])),
    ).toEqual(ORDER_COMMANDS)
  })

  // Kills: a privacy paragraph that promises more than the withholder does (an address typed into a note).
  it('AC-9: the privacy section keeps the placeholder sentence for the assistant and adds one for agents: the fields are withheld from agents’ results, emails and phones typed into text are replaced, and street lines or postcodes typed into a note only where they repeat the record’s own value, other addresses typed into notes not being detected', () => {
    const privacy = section(read(DATA_PAGE), /privacy/i)
    const said: Record<string, boolean> = {
      'the assistant’s placeholder sentence': /replaced with placeholders/i.test(privacy),
      'withheld from agents': paragraphs(privacy).some(
        (p) => /agents?\b/i.test(p) && /withheld/i.test(p),
      ),
      'typed emails and phones replaced': paragraphs(privacy).some(
        (p) => /typed/i.test(p) && /email/i.test(p) && /phone/i.test(p) && /replace/i.test(p),
      ),
      'street lines and postcodes only where they repeat': paragraphs(privacy).some(
        (p) => /street/i.test(p) && /postcode/i.test(p) && /repeat/i.test(p),
      ),
      'other addresses not detected': /not detected/i.test(privacy),
    }

    expect(privacy.trim().length, `${DATA_PAGE} has no privacy section`).toBeGreaterThan(0)
    expect(
      Object.entries(said)
        .filter(([, ok]) => !ok)
        .map(([name]) => name),
    ).toEqual([])
  })
})
