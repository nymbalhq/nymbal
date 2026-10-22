import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

type Budgets = Record<
  string,
  Record<string, { lcpMs: number; cls: number; tbtMs: number; scriptBytes: number }>
>

const TEMPLATES = ['astro', 'nextjs'] as const
const PAGES = ['home', 'listing', 'product', 'cart', 'checkout'] as const
const key = (template: string, page: string): string => `${template} / ${page}`
// P2-18 AC-6 (spec Decision 8): the pages arrive server-rendered, so the two Next exceptions (cart and checkout at
// 3000 ms, P2-08's spec ruling 3) are gone and every page has the one limit.
const LCP_LIMIT_MS = 2500

// P2-08 AC-4 (Decision 3), the part that needs no Chrome: the committed perf-budgets.json budgets the five pages of both
// templates, no budget is looser than the absolute limits (LCP 2500 ms on every page since P2-18 AC-6), and each
// scriptBytes is a whole number of KiB (the measured value plus 5%, rounded up). Kills: a budget raised past a limit to
// let a slow page through, a page left unbudgeted, or an LCP exception left in place after P2-18.
describe('P2-08 AC-4: perf-budgets.json', () => {
  it('AC-4: budgets every page of Decision 4 on both templates, within LCP 2500 ms (P2-18 AC-6: no exception), CLS 0.1 and TBT 200 ms, scriptBytes in whole KiB', () => {
    const budgets = JSON.parse(
      readFileSync(new URL('../../perf-budgets.json', import.meta.url), 'utf8'),
    ) as Budgets
    const pages = Object.entries(budgets).flatMap(([template, byPage]) =>
      Object.keys(byPage).map((page) => key(template, page)),
    )
    expect(pages.sort()).toEqual(TEMPLATES.flatMap((t) => PAGES.map((p) => key(t, p))).sort())
    for (const [template, byPage] of Object.entries(budgets)) {
      for (const [page, budget] of Object.entries(byPage)) {
        const at = key(template, page)
        expect(budget.lcpMs, `${at} lcpMs`).toBeLessThanOrEqual(LCP_LIMIT_MS)
        expect(budget.cls, `${at} cls`).toBeLessThanOrEqual(0.1)
        expect(budget.tbtMs, `${at} tbtMs`).toBeLessThanOrEqual(200)
        expect(budget.scriptBytes, `${at} scriptBytes`).toBeGreaterThan(0)
        expect(budget.scriptBytes % 1024, `${at} scriptBytes in whole KiB`).toBe(0)
      }
    }
  })
})

// P2-18 AC-6 (spec Decision 6): the server HTML holds the cart page's and the checkout's box, so the `:not(:defined)`
// reservations P2-08 added for them are gone from both templates' global stylesheets, and the CLS budget above is met
// without them. Kills: a reservation left in place, which keeps CLS green whether or not the server renders the box.
describe('P2-18 AC-6: the reservations are gone', () => {
  const STYLESHEETS = ['templates/astro/src/styles/global.css', 'templates/nextjs/app/globals.css']

  it('AC-6: neither template’s global stylesheet reserves nymbal-cart-page or nymbal-checkout with :not(:defined)', () => {
    const reservations = STYLESHEETS.flatMap((path) => {
      const css = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
      return [...css.matchAll(/nymbal-(?:cart-page|checkout):not\(:defined\)/g)].map(
        (m) => `${path}: ${m[0]}`,
      )
    })
    expect(reservations).toEqual([])
  })
})
