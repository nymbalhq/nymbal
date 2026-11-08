// Reads: apps/docs/src/content/docs/assistant-data.md, apps/docs/src/content/docs/agents.md
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from './adapter-table'

// AC-14: the docs say what now leaves the store and what does not. The assistant-data page names the customer fields a
// list summary sends the provider (email, first and last name, postcode) and says the cards under an answer are read by
// the admin from the store, none of their content sent to the provider; the agents page names the orders list's
// `postcode` and `country` filters and the `total` it answers. Links and private words stay public-docs.test.ts's.

const DOCS = 'apps/docs/src/content/docs/'
const read = (page: string): string => readFileSync(join(ROOT, DOCS, page), 'utf8')

/** The page's paragraphs and list items, each as one line of text. */
function blocks(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .flatMap((block) => (/^\s*[-*] /m.test(block) ? block.split(/\n(?=\s*[-*] )/) : [block]))
    .map((block) => block.replace(/\s+/g, ' ').trim())
    .filter((block) => block !== '')
}

/** What a list-summary paragraph must name of the customer, each as the page may write it. */
const SUMMARY_FIELDS: Record<string, RegExp> = {
  email: /\bemails?\b/i,
  'first name': /\bfirst(?: and last)? names?\b|\bfirstName\b/i,
  'last name': /\blast names?\b|\blastName\b/i,
  postcode: /\bpostcodes?\b|\bpostalCode\b/i,
}

describe('AC-14: the docs on list summaries, record cards and the order filters', () => {
  it('AC-14: assistant-data.md has a paragraph on list summaries naming email, first and last name and postcode, and a paragraph on the cards saying the admin reads them from the store and none of their content is sent to the provider', () => {
    const paragraphs = blocks(read('assistant-data.md'))
    const summaries = paragraphs.filter((p) => /\bsummar(y|ies)\b/i.test(p))
    const named = Object.keys(SUMMARY_FIELDS).filter((field) =>
      summaries.some((p) => SUMMARY_FIELDS[field]!.test(p)),
    )
    const cards = paragraphs.filter(
      (p) =>
        /\bcards?\b/i.test(p) &&
        /\badmin\b/i.test(p) &&
        /\bstore\b/i.test(p) &&
        /\bprovider\b/i.test(p) &&
        /\b(none|not|never|nothing)\b/i.test(p),
    )

    expect(named).toEqual(Object.keys(SUMMARY_FIELDS))
    expect(cards.length).toBeGreaterThanOrEqual(1)
  })

  it('AC-14: agents.md has a paragraph naming admin_orders_list with its `postcode` and `country` filters and the `total` it answers', () => {
    const paragraphs = blocks(read('agents.md')).filter((p) => p.includes('admin_orders_list'))
    const wanted = ['`postcode`', '`country`', '`total`']
    const best = paragraphs
      .map((p) => wanted.filter((word) => p.includes(word)))
      .sort((a, b) => b.length - a.length)[0]

    expect(best ?? []).toEqual(wanted)
  })
})
