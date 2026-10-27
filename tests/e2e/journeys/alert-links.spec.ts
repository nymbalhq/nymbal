import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page, Request, TestInfo } from '@playwright/test'
import {
  adjustStock,
  confirmThroughApi,
  isBackInStock,
  isConfirmation,
  linkTo,
  mailbox,
  openAndPress,
  submitOf,
  subscribeThroughApi,
  type Mailbox,
} from '../support/alerts'
import { isCustomProject, storeCapabilities, type StoreCapabilities } from '../support/capabilities'
import { adminToken, ownProduct, type OwnProduct } from '../support/checkout'
import { expect, test } from '../support/fixtures'
import { noScript } from '../support/server-rendered'

// The links in an alert email open a page with one button, on both templates. Opening the link, as a mail scanner or a
// link preview does (a plain fetch, or a browser that runs the page's scripts), leaves the subscription as it was; the
// press, a plain form POST to the page itself, confirms or stops the alert, with JavaScript on or off, and one press is
// one POST. Each journey reads GET /api/capabilities and asserts the branch it reports (@capabilities): the Mailpit
// store mails, so its links carry real tokens; the native store mails nothing, so its pages are pressed with a token
// the store never issued.

const CONFIRM = '/alerts/confirm'
const UNSUBSCRIBE = '/alerts/unsubscribe'

/** Every test id an alert page shows: its form and button before the press, one result after. */
const PAGE_IDS = [
  'alert-confirm-form',
  'alert-confirm-submit',
  'alert-unsubscribe-form',
  'alert-unsubscribe-submit',
]
const RESULT_IDS = ['alert-confirmed', 'alert-unsubscribed', 'alert-link-invalid']
const ANY_RESULT = /^alert-(confirmed|unsubscribed|link-invalid)$/

/** Whether the report says the store's email delivers; a report without the field reads as no answer. */
function delivers(caps: StoreCapabilities): unknown {
  return (caps as { email?: { delivers?: unknown } }).email?.delivers
}

function storefrontOrigin(testInfo: TestInfo): string {
  const base = testInfo.project.use.baseURL
  if (base === undefined) throw new Error(`project ${testInfo.project.name} has no baseURL`)
  return new URL(base).origin
}

const address = (role: string, tag: string): string => `alert-links-${role}-${tag}@nymbal.dev`

/** A path to an alert page with a token the store never issued. */
const unknownLink = (path: string): string => `${path}?token=never-issued-${randomUUID()}`

/** The alert test ids in the document, in a fixed order, among `ids`. */
async function idsShown(page: Page, ids: string[]): Promise<string[]> {
  const present = await page
    .locator('[data-testid]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? ''))
  return ids.filter((id) => present.includes(id))
}

/** Counts the POSTs the page sends to `path`, for as long as the listener is on. */
function postsTo(page: Page, path: string): { count: () => number; stop: () => void } {
  const seen: string[] = []
  const listener = (req: Request): void => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === path) seen.push(req.url())
  }
  page.on('request', listener)
  return { count: () => seen.length, stop: () => page.off('request', listener) }
}

/** Subscribed through the API with the storefront's Origin; answers the confirmation's links. */
async function subscribed(
  request: APIRequestContext,
  mail: Mailbox,
  origin: string,
  email: string,
  product: OwnProduct,
): Promise<{ confirm: URL; unsubscribe: URL }> {
  const sub = await subscribeThroughApi(request, origin, email, product.variantId)
  expect(sub.status, sub.text).toBe(202)
  const confirmation = (await mail.waitFor(email, 1)).filter(isConfirmation).at(-1)
  if (confirmation === undefined) throw new Error(`no confirmation reached ${email}`)
  return {
    confirm: linkTo(confirmation, CONFIRM),
    unsubscribe: linkTo(confirmation, UNSUBSCRIBE),
  }
}

/** Confirmed through the API, as a storefront server would; the row is active after. */
async function confirmedThroughApi(request: APIRequestContext, link: URL): Promise<void> {
  const answer = await confirmThroughApi(request, link.searchParams.get('token') ?? '')
  expect(answer.status, answer.text).toBe(200)
}

async function alertCounts(mail: Mailbox, who: string[], slug: string): Promise<number[]> {
  return Promise.all(
    who.map(async (w) => (await mail.messages(w)).filter((m) => isBackInStock(m, slug)).length),
  )
}

/** The native store refuses a subscribe: there is no mail, so no link to open. */
async function refusedOnNative(
  request: APIRequestContext,
  testInfo: TestInfo,
  product: OwnProduct,
): Promise<void> {
  const refused = await subscribeThroughApi(
    request,
    storefrontOrigin(testInfo),
    address('native', randomUUID().slice(0, 8)),
    product.variantId,
  )
  expect([
    refused.status,
    (JSON.parse(refused.text) as { error?: { code?: string } }).error?.code,
  ]).toEqual([409, 'alerts.unavailable'])
}

test.describe('alert links behind a button', () => {
  test('AC-1: a plain GET of a confirm or unsubscribe link, and a page that loads and runs its scripts, change nothing; pressing the button confirms or stops the alert, and one restock mails exactly the confirmed @capabilities', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(180_000)
    const caps = await storeCapabilities(request)
    const delivering = isCustomProject(testInfo.project.name)
    expect(delivers(caps), JSON.stringify(caps)).toBe(delivering)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 0)

    if (!delivering) {
      await refusedOnNative(request, testInfo, product)
      return
    }

    const origin = storefrontOrigin(testInfo)
    const mail = await mailbox()
    const tag = randomUUID().slice(0, 8)
    const [g, k, u, v] = ['g', 'k', 'u', 'v'].map((role) => address(role, tag)) as [
      string,
      string,
      string,
      string,
    ]

    // G and K are left pending; U and V are confirmed through the API.
    const links = {
      g: await subscribed(request, mail, origin, g, product),
      k: await subscribed(request, mail, origin, k, product),
      u: await subscribed(request, mail, origin, u, product),
      v: await subscribed(request, mail, origin, v, product),
    }
    await confirmedThroughApi(request, links.u.confirm)
    await confirmedThroughApi(request, links.v.confirm)

    const scanned = [links.g.confirm, links.k.confirm, links.u.unsubscribe, links.v.unsubscribe]
    for (const link of scanned) {
      const submit = submitOf(link.href)

      // A scanner's fetch: the page, its button, and no result.
      const res = await request.get(link.href)
      const html = await res.text()
      expect(
        {
          status: res.status(),
          button: html.includes(`data-testid="${submit}"`),
          result: /data-testid="alert-(confirmed|unsubscribed)"/.test(html),
        },
        `GET ${link.pathname}`,
      ).toEqual({ status: 200, button: true, result: false })

      // A preview that loads the page and runs its scripts: nothing posts, however long it stays open.
      const posts = postsTo(page, link.pathname)
      await page.goto(link.href)
      await page.waitForLoadState('networkidle')
      await expect(page.getByTestId(submit)).toBeVisible()
      expect(
        { posts: posts.count(), results: await idsShown(page, RESULT_IDS) },
        `${link.pathname} opened with JavaScript on`,
      ).toEqual({ posts: 0, results: [] })
      posts.stop()
    }

    // K presses confirm; V presses unsubscribe.
    await openAndPress(page, links.k.confirm.href)
    const confirmed = page.getByTestId('alert-confirmed')
    await expect(confirmed).toHaveAttribute('data-kind', 'back_in_stock')
    await expect(confirmed.locator(`a[href$="/product/${product.slug}"]`)).toHaveCount(1)
    await openAndPress(page, links.v.unsubscribe.href)
    await expect(page.getByTestId('alert-unsubscribed')).toHaveCount(1)

    // One restock: K (pressed) and U (scanned) are mailed; only once both have been is G and V's absence read.
    await adjustStock(request, token, product.variantId, 2, `alert-links-ac1-${randomUUID()}`)
    await expect
      .poll(() => alertCounts(mail, [k, u], product.slug), { timeout: 20_000 })
      .toEqual([1, 1])
    const active = new Set([k, u])
    const everyone = [g, k, u, v]
    expect(await alertCounts(mail, everyone, product.slug), 'alerts to G, K, U, V').toEqual(
      everyone.map((who) => (active.has(who) ? 1 : 0)),
    )
  })

  test('AC-2: behind the button, a repeat confirm or unsubscribe shows its result again; confirm after unsubscribe, a token on the other page and an unknown token show the button, then that the link is not valid; no token shows not valid with no form @capabilities', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000)
    const caps = await storeCapabilities(request)
    const delivering = isCustomProject(testInfo.project.name)
    expect(delivers(caps), JSON.stringify(caps)).toBe(delivering)

    /** What a link's page shows on GET, and the result its button gives. */
    const pressed = async (href: string) => {
      await page.goto(href)
      await page.waitForLoadState('networkidle')
      const onGet = await idsShown(page, [...PAGE_IDS, ...RESULT_IDS])
      if (onGet.includes(submitOf(href))) {
        await page.getByTestId(submitOf(href)).click()
        await page.getByTestId(ANY_RESULT).first().waitFor({ timeout: 15_000 })
      }
      return { onGet, afterPress: await idsShown(page, RESULT_IDS) }
    }
    const behindButton = (path: string, result: string) => ({
      onGet: path === CONFIRM ? PAGE_IDS.slice(0, 2) : PAGE_IDS.slice(2),
      afterPress: [result],
    })

    const seen: Record<string, unknown> = {}
    const expected: Record<string, unknown> = {}

    if (delivering) {
      const token = await adminToken(request)
      const product = await ownProduct(request, token, 0)
      const mail = await mailbox()
      const links = await subscribed(
        request,
        mail,
        storefrontOrigin(testInfo),
        address('states', randomUUID().slice(0, 8)),
        product,
      )
      const confirmToken = links.confirm.searchParams.get('token') ?? ''
      const unsubscribeToken = links.unsubscribe.searchParams.get('token') ?? ''

      await confirmedThroughApi(request, links.confirm)
      seen['confirm, row active'] = await pressed(links.confirm.href)
      expected['confirm, row active'] = behindButton(CONFIRM, 'alert-confirmed')

      seen['confirm token on unsubscribe'] = await pressed(
        `${UNSUBSCRIBE}?token=${encodeURIComponent(confirmToken)}`,
      )
      expected['confirm token on unsubscribe'] = behindButton(UNSUBSCRIBE, 'alert-link-invalid')
      seen['unsubscribe token on confirm'] = await pressed(
        `${CONFIRM}?token=${encodeURIComponent(unsubscribeToken)}`,
      )
      expected['unsubscribe token on confirm'] = behindButton(CONFIRM, 'alert-link-invalid')

      seen['unsubscribe'] = await pressed(links.unsubscribe.href)
      expected['unsubscribe'] = behindButton(UNSUBSCRIBE, 'alert-unsubscribed')
      seen['unsubscribe, row stopped'] = await pressed(links.unsubscribe.href)
      expected['unsubscribe, row stopped'] = behindButton(UNSUBSCRIBE, 'alert-unsubscribed')

      seen['confirm after unsubscribe'] = await pressed(links.confirm.href)
      expected['confirm after unsubscribe'] = behindButton(CONFIRM, 'alert-link-invalid')
    }

    for (const path of [CONFIRM, UNSUBSCRIBE]) {
      seen[`${path} unknown token`] = await pressed(unknownLink(path))
      expected[`${path} unknown token`] = behindButton(path, 'alert-link-invalid')
      for (const bare of [path, `${path}?token=`]) {
        seen[bare] = await pressed(bare)
        expected[bare] = { onGet: ['alert-link-invalid'], afterPress: ['alert-link-invalid'] }
      }
    }

    expect(seen).toEqual(expected)
  })

  test('AC-3: with JavaScript off, a confirm link’s button confirms and its unsubscribe link’s button stops the alert, so a restock that mails the control mails that address nothing @capabilities', async ({
    browser,
    request,
  }, testInfo) => {
    test.setTimeout(120_000)
    const caps = await storeCapabilities(request)
    const delivering = isCustomProject(testInfo.project.name)
    expect(delivers(caps), JSON.stringify(caps)).toBe(delivering)
    const context = await noScript(browser, testInfo)
    const page = await context.newPage()

    if (!delivering) {
      for (const path of [CONFIRM, UNSUBSCRIBE]) {
        await openAndPress(page, unknownLink(path))
        await expect(
          page.getByTestId('alert-link-invalid'),
          `${path} without JavaScript`,
        ).toHaveCount(1)
      }
      await context.close()
      return
    }

    const token = await adminToken(request)
    const product = await ownProduct(request, token, 0)
    const origin = storefrontOrigin(testInfo)
    const mail = await mailbox()
    const tag = randomUUID().slice(0, 8)
    const [pressedOff, control] = ['nojs', 'control'].map((role) => address(role, tag)) as [
      string,
      string,
    ]

    const links = await subscribed(request, mail, origin, pressedOff, product)
    await confirmedThroughApi(
      request,
      (await subscribed(request, mail, origin, control, product)).confirm,
    )

    await openAndPress(page, links.confirm.href)
    const confirmed = page.getByTestId('alert-confirmed')
    await expect(confirmed).toHaveAttribute('data-kind', 'back_in_stock')
    await expect(confirmed.locator(`a[href$="/product/${product.slug}"]`)).toHaveCount(1)
    await openAndPress(page, links.unsubscribe.href)
    await expect(page.getByTestId('alert-unsubscribed')).toHaveCount(1)
    await context.close()

    await adjustStock(request, token, product.variantId, 2, `alert-links-ac3-${randomUUID()}`)
    await expect
      .poll(() => alertCounts(mail, [control], product.slug), { timeout: 20_000 })
      .toEqual([1])
    expect(
      await alertCounts(mail, [control, pressedOff], product.slug),
      'alerts to the control, and to the address stopped without JavaScript',
    ).toEqual([1, 0])
  })

  test('AC-4: a double-click on an alert page’s button, and Enter on it then a click, whose second input lands while the first POST is held, each send one POST and end on the result @capabilities', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(150_000)
    const caps = await storeCapabilities(request)
    const delivering = isCustomProject(testInfo.project.name)
    expect(delivers(caps), JSON.stringify(caps)).toBe(delivering)

    // On the Mailpit store a real subscription's links; on the native store, tokens it never issued.
    let pages: Array<{ href: string; result: string }>
    if (delivering) {
      const token = await adminToken(request)
      const product = await ownProduct(request, token, 0)
      const links = await subscribed(
        request,
        await mailbox(),
        storefrontOrigin(testInfo),
        address('once', randomUUID().slice(0, 8)),
        product,
      )
      pages = [
        { href: links.confirm.href, result: 'alert-confirmed' },
        { href: links.unsubscribe.href, result: 'alert-unsubscribed' },
      ]
    } else {
      pages = [CONFIRM, UNSUBSCRIBE].map((path) => ({
        href: unknownLink(path),
        result: 'alert-link-invalid',
      }))
    }

    const gestures = ['double-click', 'Enter then click'] as const
    const cases = pages.flatMap((p) => gestures.map((gesture) => ({ ...p, gesture })))
    const observed: Array<{ page: string; gesture: string; posts: number; results: string[] }> = []

    for (const { href, result, gesture } of cases) {
      const path = new URL(href, 'http://localhost').pathname
      await page.goto(href)
      await page.waitForLoadState('networkidle')
      const button = page.getByTestId(submitOf(href))
      await expect(button, `${path} before the ${gesture}`).toBeVisible()

      // The page's POST is held until the gesture's second input has landed on the button it is still showing.
      let release: () => void = () => undefined
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      await page.route(
        (url) => url.pathname === path,
        async (route) => {
          if (route.request().method() !== 'POST') return route.fallback()
          await held
          await route.continue().catch(() => undefined)
        },
      )
      const posts = postsTo(page, path)
      const box = await button.boundingBox()
      if (box === null) throw new Error(`${path}: the button has no box`)
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2

      // The clicks are the mouse's and the Enter does not wait after: a locator's action can wait on the navigation
      // the first input started (a plain form POST), which the held POST never lets commit. The second input waits
      // until the first POST is out: two inputs sent back to back reach Chromium before its form navigation starts,
      // and it merges two native submissions into one POST, so an unguarded form would pass.
      if (gesture === 'double-click') {
        await page.mouse.click(x, y)
      } else {
        await button.press('Enter', { noWaitAfter: true })
      }
      await expect
        .poll(posts.count, { message: `${path}: the ${gesture}'s first input posted` })
        .toBe(1)
      if (gesture === 'double-click') {
        await page.mouse.down({ clickCount: 2 })
        await page.mouse.up({ clickCount: 2 })
      } else {
        await page.mouse.click(x, y)
      }
      release()

      await page.getByTestId(result).waitFor({ timeout: 15_000 })
      await page.waitForLoadState('networkidle')
      observed.push({
        page: path,
        gesture,
        posts: posts.count(),
        results: await idsShown(page, RESULT_IDS),
      })
      posts.stop()
      await page.unrouteAll({ behavior: 'ignoreErrors' })
    }

    expect(observed).toEqual(
      cases.map(({ href, result, gesture }) => ({
        page: new URL(href, 'http://localhost').pathname,
        gesture,
        posts: 1,
        results: [result],
      })),
    )
  })
})
