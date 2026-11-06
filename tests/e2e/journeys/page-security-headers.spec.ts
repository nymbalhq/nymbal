import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page, Response } from '@playwright/test'
import { adminToken, openCheckout, ownProduct, walkToPayment } from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { isNext } from '../support/elements'
import { expect, test } from '../support/fixtures'
import { signIn } from '../support/sign-in'

// AC-3 on both templates (the astro and nextjs projects run this file, on their dev servers): every page answer carries
// the template's page policy, one Content-Security-Policy with frame-ancestors 'none' and object-src 'none', and the
// order page keeps its own Referrer-Policy (Next's strict-origin, Astro's no-referrer) beside it. A shopper's walk from
// a product page through the cart and a stub-payment checkout to sign-in and the account runs under that policy with no
// securitypolicyviolation event and no "Refused to" console message: the policy blocks nothing a page needs.

const PASSWORD = 'TestPassword123!'
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

/** Every value the answer carried for a header, as sent. */
async function headerValues(res: Response | null, name: string): Promise<string[]> {
  return ((await res?.headersArray()) ?? [])
    .filter((h) => h.name.toLowerCase() === name)
    .map((h) => h.value)
}

async function registeredShopper(request: APIRequestContext): Promise<string> {
  const email = `e2e-csp-${randomUUID().slice(0, 8)}@e2e.test`
  const res = await request.post(`${API_URL}/api/auth/register`, {
    headers: await csrf(request),
    data: { email, password: PASSWORD, firstName: 'Policy', lastName: 'Shopper' },
  })
  expect(res.status(), `POST /api/auth/register: ${await res.text()}`).toBe(201)
  return email
}

/**
 * Every securitypolicyviolation event any document of the page fires, and every console message starting "Refused to",
 * from before the first script of each document runs.
 */
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

/** The page's main-frame document answers from now on, with their CSP header values. */
function watchDocuments(page: Page): () => Promise<Array<{ path: string; csp: string[] }>> {
  const answers: Array<Promise<{ path: string; csp: string[] }>> = []
  page.on('response', (res) => {
    const req = res.request()
    if (!req.isNavigationRequest() || req.frame() !== page.mainFrame()) return
    answers.push(headerValues(res, CSP).then((csp) => ({ path: new URL(res.url()).pathname, csp })))
  })
  return () => Promise.all(answers)
}

test.describe('AC-3: every page answers the template’s page policy', () => {
  // Kills: no page header (the store can be framed, a plugin or a foreign <base> loaded); a second, conflicting policy
  // header; the policy's headers() entry replacing the order page's Referrer-Policy.
  test('AC-3: the product, cart, checkout, sign-in, account and order pages each answer one content-security-policy with frame-ancestors none and object-src none, the same on every page, and the order page keeps its Referrer-Policy', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000)
    const product = await ownProduct(request, await adminToken(request), 5)
    const email = await registeredShopper(request)
    const answered: Array<{ path: string; csp: string[] }> = []
    const visit = async (path: string) => {
      const res = await page.goto(path)
      answered.push({ path, csp: await headerValues(res, CSP) })
      return res
    }

    await visit(`/product/${product.slug}`)
    await visit('/cart')
    await visit('/checkout')
    await visit('/account/login')
    const order = await visit('/order/NYM-NOT-AN-ORDER')
    await signIn(page, email, PASSWORD)
    await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === '/account', {
      timeout: 15_000,
    })
    await visit('/account')

    expect(
      answered.map(({ path, csp }) => ({ path, headers: csp.length })),
      'Content-Security-Policy headers per page',
    ).toEqual(answered.map(({ path }) => ({ path, headers: 1 })))
    const policies = answered.map(({ csp }) => directives(csp[0]!))
    expect(policies.map((p) => p.get('frame-ancestors'))).toEqual(policies.map(() => ["'none'"]))
    expect(policies.map((p) => p.get('object-src'))).toEqual(policies.map(() => ["'none'"]))
    expect(
      new Set(answered.map(({ csp }) => csp[0])).size,
      'one template policy for every page',
    ).toBe(1)
    expect(
      await headerValues(order, 'referrer-policy'),
      'the order page’s Referrer-Policy',
    ).toEqual([isNext(testInfo) ? 'strict-origin' : 'no-referrer'])
  })

  // Kills: a policy that blocks something a page needs on the walk (the API's origin left out of connect-src, an
  // inline style or script the template ships, the payment step's frame).
  test('AC-3: product page, add to cart, checkout with stub payments, sign in, account: every document answers under the policy and none records a securitypolicyviolation or a "Refused to" message', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000)
    const product = await ownProduct(request, await adminToken(request), 5)
    const email = await registeredShopper(request)
    const violations = await watchViolations(page)
    const documents = watchDocuments(page)

    await openCheckout(page, product)
    await walkToPayment(page, email)
    await page.getByTestId('place-order').click()
    await page.waitForURL((url) => /^\/order\/[^/]+\/?$/.test(url.pathname), { timeout: 20_000 })
    const orderNumber = decodeURIComponent(new URL(page.url()).pathname.split('/')[2]!)
    await expect(page.getByTestId('order-number')).toHaveText(orderNumber, { timeout: 15_000 })
    await signIn(page, email, PASSWORD)
    await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === '/account', {
      timeout: 15_000,
    })
    await expect(page.getByTestId('account-dashboard')).toContainText(email, { timeout: 15_000 })
    await page.waitForLoadState('networkidle')

    const walked = await documents()
    expect(
      walked.map((d) => d.path),
      'documents the walk loaded',
    ).toEqual(expect.arrayContaining([`/product/${product.slug}`, '/account/login']))
    expect(
      walked.filter(({ csp }) => csp.length !== 1 || !/frame-ancestors 'none'/.test(csp[0]!)),
      'documents on the walk without the page policy',
    ).toEqual([])
    expect(violations).toEqual([])
  })
})
