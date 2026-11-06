import type { APIResponse, Page } from '@playwright/test'
import { adminToken, openCheckout, ownProduct } from '../support/checkout'
import { API_URL } from '../support/csrf'
import { expect, test } from '../support/fixtures'

// AC-4 on the production builds (playwright.prod.config.ts: astro-prod and nextjs-prod): the product page and the
// checkout answer the production page policy, which carries no dev allowance ('unsafe-eval', a websocket source), and
// a shopper's walk from the product page through the cart to the checkout records no securitypolicyviolation event.
// The dev servers' policy adds what they need, so only a build shows what the production policy blocks: an ISR page's
// inline script, an inlined stylesheet.

const CSP = 'content-security-policy'

/** A CSP as directive name to its sources. */
function directives(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (name) out.set(name.toLowerCase(), sources)
  }
  return out
}

function headerValues(res: APIResponse, name: string): string[] {
  return res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === name)
    .map((h) => h.value)
}

/** Every securitypolicyviolation event any document of the page fires, from before its first script runs. */
async function watchViolations(page: Page): Promise<string[]> {
  const seen: string[] = []
  await page.exposeFunction('__nymbalPolicyViolation', (line: string) => {
    seen.push(line)
  })
  await page.addInitScript(() => {
    document.addEventListener(
      'securitypolicyviolation',
      (e) => {
        const report = (window as unknown as { __nymbalPolicyViolation(line: string): void })
          .__nymbalPolicyViolation
        report(`${location.pathname}: ${e.effectiveDirective} blocked ${e.blockedURI || 'inline'}`)
      },
      true,
    )
  })
  page.on('console', (msg) => {
    if (msg.text().startsWith('Refused to')) seen.push(`console: ${msg.text()}`)
  })
  return seen
}

test.describe('AC-4: the production page policy (production build)', () => {
  // Kills: the dev allowance shipped to production ('unsafe-eval' or a websocket in a built page's policy), or a
  // production policy that blocks what a built page needs, which the dev servers' looser policy hides.
  test('AC-4: the product page and the checkout answer one policy with frame-ancestors none, object-src none and no unsafe-eval or websocket source, and product page, add to cart, checkout records no securitypolicyviolation', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const product = await ownProduct(request, await adminToken(request), 5)
    const pdp = await request.get(`/product/${product.slug}`)
    const checkout = await request.get('/checkout')
    const violations = await watchViolations(page)

    await openCheckout(page, product)
    await expect(page.getByTestId('contact-email')).toBeEditable({ timeout: 15_000 })
    await page.waitForLoadState('networkidle')

    const answered = [
      { page: 'product', csp: headerValues(pdp, CSP) },
      { page: 'checkout', csp: headerValues(checkout, CSP) },
    ]
    expect(answered.map(({ page: p, csp }) => ({ page: p, headers: csp.length }))).toEqual([
      { page: 'product', headers: 1 },
      { page: 'checkout', headers: 1 },
    ])
    for (const { page: p, csp } of answered) {
      const policy = directives(csp[0]!)
      const sources = [...policy.values()].flat()
      expect(policy.get('frame-ancestors'), p).toEqual(["'none'"])
      expect(policy.get('object-src'), p).toEqual(["'none'"])
      // Kills: a build that bakes in another API origin (the page's own calls refused), or a connect-src widened past
      // the API and the payment provider (a page that may send a shopper's data anywhere).
      expect([...(policy.get('connect-src') ?? [])].sort(), `${p}: connect-src`).toEqual(
        ["'self'", new URL(API_URL).origin, 'https://api.stripe.com'].sort(),
      )
      expect(
        sources.filter((s) => s === "'unsafe-eval'" || /^wss?:/i.test(s) || s.includes('*')),
        `${p}: dev allowances`,
      ).toEqual([])
    }
    expect(violations).toEqual([])
  })
})
