import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

type Budgets = Record<
  string,
  Record<string, { lcpMs: number; cls: number; tbtMs: number; scriptBytes: number }>
>

const TEMPLATES = ['astro', 'nextjs'] as const
const PAGES = ['home', 'listing', 'product', 'cart', 'checkout'] as const
const key = (template: string, page: string): string => `${template} / ${page}`
// AC-6: the pages arrive server-rendered, so every page has the one limit but two: the Next home and listing, whose
// RSC flight payload repeats every server-rendered element's styles, sit at 3000 ms until the per-element styles are
// sent once. No other page may carry an exception, and no exception may exceed 3000 ms.
const LCP_LIMIT_MS = 2500
const LCP_EXCEPTIONS_MS: Record<string, number> = {
  [key('nextjs', 'home')]: 3000,
  [key('nextjs', 'listing')]: 3000,
}

// AC-4, the part that needs no Chrome: the committed perf-budgets.json budgets the five pages of both templates, no
// budget is looser than the absolute limits (LCP 2500 ms on every page but the recorded exceptions), and each
// scriptBytes is a whole number of KiB (the measured value plus 5%, rounded up).
describe('AC-4: perf-budgets.json', () => {
  it('AC-4: budgets the five pages on both templates, within LCP 2500 ms (nextjs home and listing at 3000), CLS 0.1 and TBT 200 ms, scriptBytes in whole KiB', () => {
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
        expect(budget.lcpMs, `${at} lcpMs`).toBeLessThanOrEqual(
          LCP_EXCEPTIONS_MS[at] ?? LCP_LIMIT_MS,
        )
        expect(budget.cls, `${at} cls`).toBeLessThanOrEqual(0.1)
        expect(budget.tbtMs, `${at} tbtMs`).toBeLessThanOrEqual(200)
        expect(budget.scriptBytes, `${at} scriptBytes`).toBeGreaterThan(0)
        expect(budget.scriptBytes % 1024, `${at} scriptBytes in whole KiB`).toBe(0)
      }
    }
  })
})

// AC-6: the server HTML holds the cart page's and the checkout's box, so neither template's global stylesheet holds a
// `:not(:defined)` reservation for them, and the CLS budget above is met without one.
describe('AC-6: the reservations are gone', () => {
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
