import type { Page } from '@playwright/test'
import { API_URL } from '../support/csrf'
import { blockExternalRequests, expect, test } from '../support/fixtures'
import { phoneWidths } from '../support/phone-width'
import { PRODUCT, upgraded } from '../support/server-rendered'

// At a phone's width the product page's add-to-cart button is never under a sticky layer: not under the sticky site
// header once something brings it into view (a scroll-into-view, or keyboard focus), and not under any sticky layer
// (the header, the gallery) at any scroll position where its centre is in view below the header. Tagged
// @phone-width, so only the astro-mobile and nextjs-mobile projects run it, at Pixel 7.

const HOST = 'nymbal-add-to-cart'

interface Geometry {
  scrollY: number
  innerHeight: number
  headerBottom: number
  top: number
  bottom: number
  centreY: number
  /** `nymbal-add-to-cart` when the topmost element at the button's centre is inside it, else what is on top. */
  onTop: string
}

/** The button's and the header's edges, and what the browser hits at the button's centre (through shadow roots). */
function geometry(page: Page): Promise<Geometry> {
  return page.evaluate((hostTag) => {
    const host = document.querySelector(hostTag)
    const button = host?.shadowRoot?.querySelector('[data-testid="add-to-cart"]')
    const header = document.querySelector('nymbal-site-header')
    if (!host || !button || !header)
      throw new Error('no add-to-cart button or site header on the page')
    const b = button.getBoundingClientRect()
    const x = b.left + b.width / 2
    const y = b.top + b.height / 2
    const outer = document.elementFromPoint(x, y)
    let hit: Element | null = outer
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y)
      if (inner === null || inner === hit) break
      hit = inner
    }
    let inside = false
    for (let node: Node | null = hit; node !== null; ) {
      if (node === host) {
        inside = true
        break
      }
      node = node instanceof ShadowRoot ? node.host : node.parentNode
    }
    const describe = (el: Element | null): string =>
      el === null
        ? 'nothing'
        : `${el.localName}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`
    return {
      scrollY: window.scrollY,
      innerHeight: window.innerHeight,
      headerBottom: header.getBoundingClientRect().bottom,
      top: b.top,
      bottom: b.bottom,
      centreY: y,
      onTop: inside
        ? hostTag
        : outer === hit
          ? describe(hit)
          : `${describe(outer)} > ${describe(hit)}`,
    }
  }, HOST)
}

/** Resolves once the window has not scrolled for ten frames in a row: both templates scroll smoothly. */
function scrollSettled(page: Page): Promise<void> {
  return page.evaluate(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    let last = window.scrollY
    let still = 0
    for (let frames = 0; still < 10 && frames < 600; frames += 1) {
      await frame()
      if (window.scrollY === last) still += 1
      else {
        still = 0
        last = window.scrollY
      }
    }
  })
}

/** Jumps to `y` with no smooth scrolling and waits a frame for the sticky layers to settle. */
async function jumpTo(page: Page, y: number): Promise<void> {
  await page.evaluate(async (top) => {
    window.scrollTo({ top, behavior: 'instant' })
    await new Promise((resolve) => requestAnimationFrame(resolve))
  }, y)
}

/** The product page at a phone's width, its header and add-to-cart upgraded and its images settled. */
async function openProduct(page: Page): Promise<void> {
  // A product the API holds in stock, so its add-to-cart button is enabled and focusable.
  const res = await page.request.get(`${API_URL}/api/products/${PRODUCT}`)
  expect(res.status(), `GET /api/products/${PRODUCT}`).toBe(200)
  const { variants } = ((await res.json()) as { data: { variants: Array<{ stock?: number }> } })
    .data
  expect(
    variants.reduce((units, variant) => units + (variant.stock ?? 0), 0),
    'units in stock',
  ).toBeGreaterThanOrEqual(1)
  await blockExternalRequests(page)
  await page.goto(`/product/${PRODUCT}`, { waitUntil: 'load' })
  const { viewport } = await phoneWidths(page, 'product')
  expect(viewport, 'a phone-width journey').toBeLessThanOrEqual(480)
  await upgraded(page, ['nymbal-site-header', HOST])
  await expect(page.locator(HOST).getByTestId('add-to-cart')).toBeEnabled({ timeout: 15_000 })
}

test.describe('Sticky layers over the product page’s actions @phone-width', () => {
  test('AC-8: add-to-cart brought into view by scrollIntoView({ block: "start" }) ends below the sticky header, and is what the browser hits at its centre', async ({
    page,
  }) => {
    await openProduct(page)
    await jumpTo(page, 0)
    await page
      .locator(HOST)
      .getByTestId('add-to-cart')
      .evaluate((button) => button.scrollIntoView({ block: 'start' }))
    await scrollSettled(page)
    const g = await geometry(page)
    expect(g.scrollY, 'the button was below the fold, so the page scrolled').toBeGreaterThan(0)
    expect(
      g.top,
      `button top against the header's bottom edge at scrollY ${g.scrollY}`,
    ).toBeGreaterThanOrEqual(g.headerBottom - 0.5)
    expect(g.onTop, 'the element at the button’s centre').toBe(HOST)
  })

  test('AC-8: add-to-cart reached by Tab from a scroll position that leaves it partly under the header ends below the sticky header, and is what the browser hits at its centre', async ({
    page,
  }) => {
    await openProduct(page)
    // A focusable start just before the add-to-cart element, out of the flow so the row keeps its layout: the next
    // Tab lands on the button, which is what the keyboard user reaches.
    await page.locator(HOST).evaluate((host) => {
      const start = document.createElement('span')
      start.tabIndex = 0
      start.style.position = 'absolute'
      host.before(start)
      start.focus({ preventScroll: true })
    })
    // The button's top edge half its height above the header's bottom edge, its bottom edge in view: Chromium aligns a
    // partly hidden element to the nearest edge on focus (a wholly hidden one it centres, which would hide the defect).
    const before = await geometry(page)
    await jumpTo(
      page,
      before.scrollY + before.top - before.headerBottom + (before.bottom - before.top) / 2,
    )
    const start = await geometry(page)
    expect(
      start.top,
      'start: the button’s top edge is above the header’s bottom edge',
    ).toBeLessThan(start.headerBottom)
    expect(start.bottom, 'start: its bottom edge is below the header').toBeGreaterThan(
      start.headerBottom,
    )
    expect(start.bottom, 'start: its bottom edge is inside the viewport').toBeLessThanOrEqual(
      start.innerHeight,
    )

    await page.keyboard.press('Tab')
    const focused = await page
      .locator(HOST)
      .evaluate(
        (host) =>
          document.activeElement === host &&
          host.shadowRoot?.activeElement?.getAttribute('data-testid') === 'add-to-cart',
      )
    expect(focused, 'Tab focused the add-to-cart button').toBe(true)
    await scrollSettled(page)
    const g = await geometry(page)
    expect(
      g.top,
      `button top against the header's bottom edge at scrollY ${g.scrollY}`,
    ).toBeGreaterThanOrEqual(g.headerBottom - 0.5)
    expect(g.onTop, 'the element at the button’s centre').toBe(HOST)
  })

  test('AC-9: at every scroll position from the top to the end, in steps of at most 100 px, whenever the add-to-cart button’s centre is in view below the header no sticky layer covers it', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await openProduct(page)
    const end = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    )
    const covered: string[] = []
    let inView = 0
    let uncovered = 0
    for (let y = 0; ; y = Math.min(y + 100, end)) {
      await jumpTo(page, y)
      const g = await geometry(page)
      if (g.centreY > g.headerBottom && g.centreY < g.innerHeight) {
        inView += 1
        if (g.onTop === HOST) uncovered += 1
        else covered.push(`scrollY ${g.scrollY}: ${g.onTop} is over the button`)
      }
      if (y >= end) break
    }
    expect(
      inView,
      'scroll positions with the button’s centre in view below the header',
    ).toBeGreaterThanOrEqual(1)
    expect(uncovered, covered.join('\n')).toBe(inView)
  })
})
