import type { Locator, Page } from '@playwright/test'
import { seedProducts } from '../../../packages/platform/src/seed/data'
import { isNext, markWindow, windowMarked } from '../support/elements'
import { blockExternalRequests, expect, test } from '../support/fixtures'
import { upgraded } from '../support/server-rendered'

// P2-17 AC-7 (spec Decision 7), on production builds of both templates: the anchors of the card, the header, the
// breadcrumb and the category nav are plain <a> in shadow roots, which Next does not route. A plain left click on one
// dispatches a cancelable, composed `nymbal:navigate` with the anchor's href; on Next `NymbalSetup` routes it, so the
// page is reached without a full load (a `window` marker survives); on Astro nobody cancels it and the anchor loads
// the page (the marker is gone). A modifier click opens the page in a new tab and a right click opens nothing; neither
// dispatches the event nor moves this page. The events are recorded in sessionStorage, which a full load in the same
// tab keeps. Kills: the event missing or not cancelable, Next losing the page state on a card click (a full load),
// a ctrl-click hijacked into this tab.

const PRODUCT = seedProducts[0]!.slug

interface Seen {
  href: string
  cancelable: boolean
  composed: boolean
}

/** Records every nymbal:navigate the document sees, before any listener of the page's own (capture phase). */
async function recordNavigates(page: Page): Promise<void> {
  await page.addInitScript(() => {
    document.addEventListener(
      'nymbal:navigate',
      (event) => {
        const seen = JSON.parse(sessionStorage.getItem('__p217Navigates') ?? '[]') as unknown[]
        seen.push({
          href: String((event as CustomEvent<{ href?: unknown }>).detail?.href),
          cancelable: event.cancelable,
          composed: event.composed,
        })
        sessionStorage.setItem('__p217Navigates', JSON.stringify(seen))
      },
      true,
    )
  })
}

async function navigatesSeen(page: Page): Promise<Seen[]> {
  return page.evaluate(
    () => JSON.parse(sessionStorage.getItem('__p217Navigates') ?? '[]') as Seen[],
  )
}

/** Two animation frames: anything a click set going synchronously has run. */
async function frames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
}

interface Anchor {
  name: string
  start: string
  tags: string[]
  anchor: (page: Page) => Locator
}

const ANCHORS: Anchor[] = [
  {
    name: 'a product card',
    start: '/products',
    tags: ['nymbal-product-grid', 'nymbal-product-card'],
    anchor: (page) =>
      page.locator('nymbal-product-grid nymbal-product-card [part~="card"]').first(),
  },
  {
    name: 'a header link',
    start: '/',
    tags: ['nymbal-site-header'],
    anchor: (page) =>
      page
        .locator('nymbal-site-header [part~="link"][href="/products"]')
        .filter({ visible: true })
        .first(),
  },
  {
    name: 'a breadcrumb link',
    start: `/product/${PRODUCT}`,
    tags: ['nymbal-breadcrumb'],
    anchor: (page) => page.locator('nymbal-breadcrumb [part~="item"][href="/products"]').first(),
  },
  {
    name: 'a category card',
    start: '/',
    tags: ['nymbal-category-nav'],
    anchor: (page) => page.locator('nymbal-category-nav [part~="card"]').first(),
  },
]

test.describe('P2-17 AC-7: soft navigation on Next through element anchors (production build)', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page)
    await recordNavigates(page)
  })

  for (const { name, start, tags, anchor } of ANCHORS) {
    test(`AC-7: a plain click on ${name} dispatches one cancelable, composed nymbal:navigate with its href and reaches it, on Next without a full load (the window marker survives), on Astro by loading the page`, async ({
      page,
    }, testInfo) => {
      await page.goto(start, { waitUntil: 'load' })
      await upgraded(page, tags)
      const link = anchor(page)
      const href = await link.getAttribute('href')
      expect(href, `${name} has an href`).toBeTruthy()
      const target = new URL(href!, page.url())
      await markWindow(page)

      await link.click()
      await page.waitForURL((url) => url.pathname === target.pathname)
      expect(await windowMarked(page), `marker after ${name} on ${testInfo.project.name}`).toBe(
        isNext(testInfo),
      )
      const seen = await navigatesSeen(page)
      expect(seen.map((s) => ({ ...s, href: new URL(s.href, target).href }))).toEqual([
        { href: target.href, cancelable: true, composed: true },
      ])
    })
  }

  test('AC-7: a modifier click on a product card opens its page in a new tab and a right click opens nothing; neither dispatches nymbal:navigate nor moves this page', async ({
    page,
    context,
  }) => {
    await page.goto('/products', { waitUntil: 'load' })
    await upgraded(page, ['nymbal-product-grid', 'nymbal-product-card'])
    const card = page.locator('nymbal-product-grid nymbal-product-card [part~="card"]').first()
    const target = new URL((await card.getAttribute('href'))!, page.url())
    const here = page.url()
    await markWindow(page)

    const opened = context.waitForEvent('page')
    await card.click({ modifiers: ['ControlOrMeta'] })
    const tab = await opened
    await tab.waitForURL((url) => url.pathname === target.pathname)
    await tab.close()
    expect(page.url(), 'a modifier click leaves this page').toBe(here)
    expect(await windowMarked(page)).toBe(true)

    await card.click({ button: 'right' })
    await frames(page)
    expect(page.url(), 'a right click leaves this page').toBe(here)
    expect(await windowMarked(page)).toBe(true)
    expect(await navigatesSeen(page), 'no nymbal:navigate for a modifier or right click').toEqual(
      [],
    )
  })
})
