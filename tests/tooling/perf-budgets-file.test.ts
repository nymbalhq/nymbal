import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

type Budgets = Record<
  string,
  Record<string, { lcpMs: number; cls: number; tbtMs: number; scriptBytes: number }>
>

const TEMPLATES = ['astro', 'nextjs'] as const
const PAGES = ['home', 'listing', 'product', 'cart', 'checkout'] as const
const key = (template: string, page: string): string => `${template} / ${page}`
// The recorded exceptions (spec ruling 3): Next renders the cart and the checkout only after hydration, so
// nextjs / cart and nextjs / checkout have 3000 ms until P2-18 server-renders them; every other page keeps 2500 ms.
const lcpLimitMs = (at: string): number => (at === 'nextjs / cart' || at === 'nextjs / checkout' ? 3000 : 2500)

// P2-08 AC-4 (Decision 3), the part that needs no Chrome: the committed perf-budgets.json budgets the five pages of both
// templates, no budget is looser than the absolute limits (LCP 2500 ms, nextjs / cart and / checkout 3000 ms until P2-18), and each scriptBytes is a whole number of KiB (the measured
// value plus 5%, rounded up). Kills: a budget raised past a limit to let a slow page through, or a page left unbudgeted.
describe('P2-08 AC-4: perf-budgets.json', () => {
  it('AC-4: budgets every page of Decision 4 on both templates, within LCP 2500 ms (nextjs / cart and / checkout 3000 ms), CLS 0.1 and TBT 200 ms, scriptBytes in whole KiB', () => {
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
        expect(budget.lcpMs, `${at} lcpMs`).toBeLessThanOrEqual(lcpLimitMs(at))
        expect(budget.cls, `${at} cls`).toBeLessThanOrEqual(0.1)
        expect(budget.tbtMs, `${at} tbtMs`).toBeLessThanOrEqual(200)
        expect(budget.scriptBytes, `${at} scriptBytes`).toBeGreaterThan(0)
        expect(budget.scriptBytes % 1024, `${at} scriptBytes in whole KiB`).toBe(0)
      }
    }
  })
})
