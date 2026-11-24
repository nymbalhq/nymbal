import { randomUUID } from 'node:crypto'
import { request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test'
import { expect, test } from '../../support/fixtures'
import { ADMIN_EMAIL, ADMIN_PASSWORD, signInAsAdmin } from '../../support/admin'
import { adminToken, ownProduct, type OwnProduct } from '../../support/checkout'
import { API_URL, csrf } from '../../support/csrf'
import { phoneWidths } from '../../support/phone-width'

// The merchant makes a 10% code on /admin/promotions and switches it off there; carts of the journey's own, through the
// API, are discounted by it while it is on and told it is rejected once it is off. At a phone's width the page holding a
// 64-character code is no wider than the viewport, and so are its Edit and Delete dialogs at any width.

/** The cart the cart routes answer, as far as a code moves it. */
interface ShopperCart {
  totals: { subtotalMinor: number; discountTotalMinor: number; totalMinor: number }
  promotions: { codes: Array<{ code: string; status: string; reason?: string }> }
}

interface ListedPromotion {
  id: string
  code: string
  percentBps: number | null
  active: boolean
}

async function listed(request: APIRequestContext, token: string): Promise<ListedPromotion[]> {
  const res = await request.get(`${API_URL}/api/admin/promotions?limit=200`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.status(), `GET /api/admin/promotions: ${await res.text()}`).toBe(200)
  return ((await res.json()) as { data: ListedPromotion[] }).data
}

/** A guest cart of its own holding one unit of `product`, then `code` added: the cart the code route answers. */
async function cartWithCode(product: OwnProduct, code: string): Promise<ShopperCart> {
  const shopper = await playwrightRequest.newContext()
  try {
    const add = await shopper.post(`${API_URL}/api/cart/items`, {
      headers: await csrf(shopper),
      data: { variantId: product.variantId, qty: 1 },
    })
    expect(add.ok(), `POST /api/cart/items: ${await add.text()}`).toBe(true)
    const res = await shopper.post(`${API_URL}/api/cart/codes`, {
      headers: await csrf(shopper),
      data: { code },
    })
    expect(res.status(), `POST /api/cart/codes: ${await res.text()}`).toBe(200)
    return ((await res.json()) as { data: ShopperCart }).data
  } finally {
    await shopper.dispose()
  }
}

/** Picks a kind on the dialog's kind control: a native select, or a group whose options are labelled by their text. */
async function chooseKind(page: Page, label: 'Percent' | 'Fixed amount'): Promise<void> {
  const kind = page.getByTestId('admin-promotion-kind')
  if ((await kind.evaluate((el) => el.tagName)) === 'SELECT') await kind.selectOption({ label })
  else await kind.getByText(label, { exact: true }).click()
}

/** The writes the page sends to the promotions routes; `settled()` waits until each has been answered. */
function watchWrites(page: Page, method: string): { sent(): number; settled(): Promise<void> } {
  let sent = 0
  let answered = 0
  const matches = (r: { method(): string; url(): string }) =>
    r.method() === method && new URL(r.url()).pathname.startsWith('/api/admin/promotions')
  page.on('request', (r) => {
    if (matches(r)) sent += 1
  })
  const onAnswered = (r: { method(): string; url(): string }) => {
    if (matches(r)) answered += 1
  }
  page.on('requestfinished', onAnswered)
  page.on('requestfailed', onAnswered)
  return {
    sent: () => sent,
    async settled() {
      await expect.poll(() => sent - answered, { message: `${method}s still in flight` }).toBe(0)
    },
  }
}

test.describe('The merchant makes and switches off a discount code', () => {
  // Kills: no page (fails on base); a double-clicked Save that makes two requests and an error; a page whose
  // "Inactive" is not what the cart enforces.
  test('AC-10: a 10% code made on /admin/promotions with Save double-clicked is one promotion with percentBps 1000 that reads "10%" and "Active" and discounts a cart by a tenth of its subtotal; switched off on the row it reads "Inactive", the API says active false, and the next cart is told it is rejected inactive with no discount', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 10)
    const code = `E2E-PROMO-${randomUUID().slice(0, 8)}`.toUpperCase()

    await signInAsAdmin(page)
    await page.goto('promotions')
    await page.getByTestId('admin-promotions-new').click({ timeout: 15_000 })
    await expect(page.getByTestId('admin-promotion-dialog')).toBeVisible()
    await page.getByTestId('admin-promotion-code').fill(code)
    await chooseKind(page, 'Percent')
    await page.getByTestId('admin-promotion-value').fill('10')
    const posts = watchWrites(page, 'POST')
    await page.getByTestId('admin-promotion-save').dblclick()
    await posts.settled()
    await expect(page.getByTestId('admin-promotions-result')).toHaveText(`Created ${code}`, {
      timeout: 15_000,
    })
    await expect(page.getByTestId('admin-promotion-error')).toHaveCount(0)

    const made = (await listed(request, token)).filter((p) => p.code === code)
    expect(
      made.map((p) => p.percentBps),
      `promotions of ${code} after ${posts.sent()} POSTs`,
    ).toEqual([1000])
    const id = made[0]!.id
    const row = page.getByTestId(`admin-promotions-row-${id}`)
    await expect(row).toContainText(code)
    await expect(row).toContainText('10%')
    await expect(page.getByTestId(`admin-promotions-state-${id}`)).toHaveText('Active')

    const discounted = await cartWithCode(product, code)
    expect(discounted.promotions.codes).toEqual([{ code, status: 'accepted' }])
    expect(discounted.totals.discountTotalMinor, 'a tenth of the subtotal').toBe(
      Math.floor(discounted.totals.subtotalMinor / 10),
    )
    expect(discounted.totals.discountTotalMinor).toBeGreaterThan(0)

    const patches = watchWrites(page, 'PATCH')
    await page.getByTestId(`admin-promotions-toggle-${id}`).click()
    await patches.settled()
    await expect(page.getByTestId(`admin-promotions-state-${id}`)).toHaveText('Inactive', {
      timeout: 15_000,
    })
    await expect(page.getByTestId('admin-promotions-result')).toHaveText(`Switched off ${code}`)
    expect(
      (await listed(request, token)).filter((p) => p.code === code).map((p) => p.active),
    ).toEqual([false])

    const refused = await cartWithCode(product, code)
    expect(refused.promotions.codes).toEqual([{ code, status: 'rejected', reason: 'inactive' }])
    expect(refused.totals.discountTotalMinor).toBe(0)
  })
})

test.describe('A row action under a result message', () => {
  // Kills: a message cleared as an action starts, which moves the table up a line so the second click of a double-click
  // lands on the next row's button.
  test('AC-6: with "Switched off <code>" showing above the table, a double-click on a row’s Switch off sends one PATCH; that row reads Inactive and the row below it stays Active', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const tag = randomUUID().slice(0, 8).toUpperCase()
    const make = async (code: string): Promise<string> => {
      const res = await request.post(`${API_URL}/api/admin/promotions`, {
        headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
        data: { code, kind: 'percent', percentBps: 1000 },
      })
      expect(res.status(), `POST /api/admin/promotions: ${await res.text()}`).toBe(201)
      return ((await res.json()) as { data: { id: string } }).data.id
    }
    // Newest first: the list reads first, then target, then below.
    const below = await make(`E2E-BELOW-${tag}`)
    const target = await make(`E2E-TARGET-${tag}`)
    const first = `E2E-FIRST-${tag}`
    const firstId = await make(first)

    await signInAsAdmin(page)
    await page.goto('promotions')
    await expect(page.getByTestId(`admin-promotions-row-${below}`)).toBeVisible({
      timeout: 15_000,
    })
    const rows = page.locator('[data-testid^="admin-promotions-row-"]')
    const order = await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')))
    const at = order.indexOf(`admin-promotions-row-${target}`)
    expect(order.slice(at, at + 2), 'the target row and the row below it').toEqual([
      `admin-promotions-row-${target}`,
      `admin-promotions-row-${below}`,
    ])

    await page.getByTestId(`admin-promotions-toggle-${firstId}`).click()
    await expect(page.getByTestId('admin-promotions-result')).toHaveText(`Switched off ${first}`, {
      timeout: 15_000,
    })
    await expect(page.getByTestId(`admin-promotions-toggle-${firstId}`)).toBeEnabled()

    const patches = watchWrites(page, 'PATCH')
    await page.getByTestId(`admin-promotions-toggle-${target}`).dblclick()
    await expect(page.getByTestId(`admin-promotions-state-${target}`)).toHaveText('Inactive', {
      timeout: 15_000,
    })
    await patches.settled()
    expect(patches.sent(), 'PATCHes sent by the double-click').toBe(1)
    await expect(page.getByTestId(`admin-promotions-state-${below}`)).toHaveText('Active')
    const active = new Map((await listed(request, token)).map((p) => [p.id, p.active]))
    expect(
      [active.get(target), active.get(below)],
      'active of the target and the row below',
    ).toEqual([false, true])
  })
})

test.describe('Promotions at a phone’s width @phone-width', () => {
  // Kills: a long code that widens the page or a dialog on a phone, or a table that clips its row's buttons.
  test('AC-11: /admin/promotions holding a 64-character code is no wider than the viewport; its table scrolls inside its card, and once scrolled the row’s buttons are inside the viewport; its Edit and Delete dialogs and their buttons stay inside the viewport', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const tag = randomUUID().replace(/-/g, '').toUpperCase()
    const code = `W${tag}`.padEnd(64, 'X')
    const res = await request.post(`${API_URL}/api/admin/promotions`, {
      headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
      data: { code, kind: 'percent', percentBps: 1000 },
    })
    expect(res.status(), `POST /api/admin/promotions: ${await res.text()}`).toBe(201)
    const id = ((await res.json()) as { data: { id: string } }).data.id
    const rowId = `admin-promotions-row-${id}`

    // Through the form: signInAsAdmin waits for a sidebar link the phone's off-canvas sidebar hides.
    await page.goto('login')
    await page.getByTestId('admin-login-email').fill(ADMIN_EMAIL)
    await page.getByTestId('admin-login-password').fill(ADMIN_PASSWORD)
    await page.getByTestId('admin-login-submit').click()
    await page.waitForURL((url) => !url.pathname.replace(/\/$/, '').endsWith('/login'), {
      timeout: 15_000,
    })
    await page.goto('promotions')
    await expect(page.getByTestId(rowId)).toContainText(code, { timeout: 15_000 })
    await expect(page.locator('main .animate-pulse')).toHaveCount(0, { timeout: 10_000 })

    const { scrollWidth, innerWidth, viewport, measured } = await phoneWidths(page, 'promotions')
    expect.soft(scrollWidth, measured).toBeLessThanOrEqual(viewport + 1)
    expect.soft(innerWidth, measured).toBe(viewport)

    // The element between the table and the page that scrolls it sideways, and no wider than the viewport.
    const wrapper = await page.getByTestId(rowId).evaluate((row) => {
      const table = row.closest('table')
      for (
        let el = table?.parentElement ?? null;
        el !== null && el !== document.body;
        el = el.parentElement
      ) {
        const overflow = getComputedStyle(el).overflowX
        if (overflow === 'auto' || overflow === 'scroll') {
          return { overflow, width: el.getBoundingClientRect().width }
        }
      }
      return { overflow: 'none', width: Number.POSITIVE_INFINITY }
    })
    expect(['auto', 'scroll'], `the table's wrapper overflow-x: ${wrapper.overflow}`).toContain(
      wrapper.overflow,
    )
    expect(wrapper.width, 'the wrapper’s width').toBeLessThanOrEqual(viewport + 1)

    for (const button of [
      `admin-promotions-toggle-${id}`,
      `admin-promotions-edit-${id}`,
      `admin-promotions-delete-${id}`,
    ]) {
      await page.getByTestId(button).scrollIntoViewIfNeeded()
      const box = await page.getByTestId(button).boundingBox()
      const left = box === null ? Number.NEGATIVE_INFINITY : box.x
      const right = box === null ? Number.POSITIVE_INFINITY : box.x + box.width
      expect
        .soft(
          { left: left >= -1, right: right <= viewport + 1 },
          `${button}: ${left} to ${right}, viewport ${viewport}`,
        )
        .toEqual({ left: true, right: true })
    }
    const after = await phoneWidths(page, 'promotions scrolled')
    expect(after.scrollWidth, after.measured).toBeLessThanOrEqual(viewport + 1)

    // Both dialogs title the code, which has no break point: neither the dialog nor its button may leave the viewport,
    // and the button stays inside the dialog's card, at the phone's width and at two wider ones.
    const widths = [viewport, 800, 1280]
    for (const width of widths) {
      if (width !== viewport) await page.setViewportSize({ width, height: 900 })
      await page.getByTestId(`admin-promotions-edit-${id}`).click()
      await expectInside(page, 'admin-promotion-dialog', 'admin-promotion-save', width)
      await cancel(page, 'admin-promotion-dialog')

      await page.getByTestId(`admin-promotions-delete-${id}`).click()
      await expectInside(
        page,
        'admin-promotion-delete-dialog',
        'admin-promotion-delete-confirm',
        width,
      )
      const confirm = page.getByTestId('admin-promotion-delete-confirm')
      if (width !== widths.at(-1)) {
        await confirm.click({ trial: true, timeout: 5_000 })
        await cancel(page, 'admin-promotion-delete-dialog')
      } else {
        await confirm.click({ timeout: 5_000 })
        await expect(page.getByTestId(rowId)).toHaveCount(0, { timeout: 10_000 })
        expect((await listed(request, token)).map((p) => p.id)).not.toContain(id)
      }
    }
  })
})

test.describe('A double-click that opens or closes a dialog at a phone’s width @phone-width', () => {
  // Kills: a button that acts on the second click of a double-click whose first click opened or closed a dialog over
  // it, so one double-click deletes or saves one promotion and switches off another, or deletes a code never confirmed.
  // `between` rows are listed between the target's and the other's, to bring the other's lower down the page.
  const pair = async (request: APIRequestContext, between = 0) => {
    const token = await adminToken(request)
    const tag = randomUUID().slice(0, 8).toUpperCase()
    const make = async (code: string): Promise<string> => {
      const res = await request.post(`${API_URL}/api/admin/promotions`, {
        headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
        data: { code, kind: 'percent', percentBps: 1000 },
      })
      expect(res.status(), `POST /api/admin/promotions: ${await res.text()}`).toBe(201)
      return ((await res.json()) as { data: { id: string } }).data.id
    }
    // Newest first: the target's row is listed above the other's.
    const other = await make(`E2E-OTHER-${tag}`)
    for (let i = 0; i < between; i += 1) await make(`E2E-FILL-${tag}-${i}`)
    const code = `E2E-AIM-${tag}`
    const target = await make(code)
    return { token, code, target, other }
  }

  const open = async (page: Page, target: string, other: string) => {
    await page.goto('login')
    await page.getByTestId('admin-login-email').fill(ADMIN_EMAIL)
    await page.getByTestId('admin-login-password').fill(ADMIN_PASSWORD)
    await page.getByTestId('admin-login-submit').click()
    await page.waitForURL((url) => !url.pathname.replace(/\/$/, '').endsWith('/login'), {
      timeout: 15_000,
    })
    await page.goto('promotions')
    await expect(page.getByTestId(`admin-promotions-row-${other}`)).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.locator('main .animate-pulse')).toHaveCount(0, { timeout: 10_000 })
    await page.getByTestId(`admin-promotions-delete-${target}`).scrollIntoViewIfNeeded()
  }

  test('a double-clicked Delete confirm over another row’s Switch off sends one DELETE and no PATCH; the other code stays active', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const { token, target, other } = await pair(request)
    await open(page, target, other)

    await page.getByTestId(`admin-promotions-delete-${target}`).click()
    const point = await over(
      page,
      'admin-promotion-delete-dialog',
      'admin-promotion-delete-confirm',
      `admin-promotions-toggle-${other}`,
    )
    const deletes = watchWrites(page, 'DELETE')
    const patches = watchWrites(page, 'PATCH')
    await page.getByTestId('admin-promotion-delete-confirm').dblclick({ position: point })
    await expect(page.getByTestId(`admin-promotions-row-${target}`)).toHaveCount(0, {
      timeout: 10_000,
    })
    await deletes.settled()
    await patches.settled()
    expect(
      { deletes: deletes.sent(), patches: patches.sent() },
      'writes sent by the double-click',
    ).toEqual({ deletes: 1, patches: 0 })
    const active = new Map((await listed(request, token)).map((p) => [p.id, p.active]))
    expect([active.has(target), active.get(other)], 'target listed, other active').toEqual([
      false,
      true,
    ])
  })

  test('a double-clicked Edit Save over another row’s Switch off, its second click after the save closed the dialog, sends one PATCH; the other code stays active', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const { token, code, target, other } = await pair(request, 8)
    await open(page, target, other)

    await page.getByTestId(`admin-promotions-edit-${target}`).click()
    const point = await over(
      page,
      'admin-promotion-dialog',
      'admin-promotion-save',
      `admin-promotions-toggle-${other}`,
    )
    const save = await page.getByTestId('admin-promotion-save').boundingBox()
    const x = save!.x + point.x
    const y = save!.y + point.y
    const patches = watchWrites(page, 'PATCH')
    // A local write answers within a double-click's interval: the second click comes once the dialog has closed.
    await page.mouse.move(x, y)
    await page.mouse.down({ clickCount: 1 })
    await page.mouse.up({ clickCount: 1 })
    await expect(page.getByTestId('admin-promotion-dialog')).toHaveCount(0, { timeout: 10_000 })
    await page.mouse.down({ clickCount: 2 })
    await page.mouse.up({ clickCount: 2 })
    await patches.settled()
    expect(patches.sent(), 'PATCHes sent by the double-click').toBe(1)
    await expect(page.getByTestId('admin-promotions-result')).toHaveText(`Saved ${code}`)
    const active = new Map((await listed(request, token)).map((p) => [p.id, p.active]))
    expect([active.get(target), active.get(other)], 'active of target and other').toEqual([
      true,
      true,
    ])
  })

  test('a double-clicked row Delete under where its confirm opens leaves the confirm open and sends no DELETE', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const { token, target, other } = await pair(request)
    await open(page, target, other)

    const del = `admin-promotions-delete-${other}`
    await page.getByTestId(del).click()
    await over(page, 'admin-promotion-delete-dialog', 'admin-promotion-delete-confirm', del)
    await cancel(page, 'admin-promotion-delete-dialog')
    const deletes = watchWrites(page, 'DELETE')
    await secondClickOnceOpen(page, del, 'admin-promotion-delete-dialog')
    await deletes.settled()
    expect(deletes.sent(), 'DELETEs sent by the double-click').toBe(0)
    await expect(page.getByTestId('admin-promotion-delete-dialog')).toBeVisible()
    expect((await listed(request, token)).map((p) => p.id)).toContain(other)
  })

  test('a double-clicked row Edit under where its Save opens leaves the dialog open and sends no PATCH', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const { target, other } = await pair(request, 8)
    await open(page, target, other)

    const edit = `admin-promotions-edit-${other}`
    await page.getByTestId(edit).click()
    await over(page, 'admin-promotion-dialog', 'admin-promotion-save', edit)
    await cancel(page, 'admin-promotion-dialog')
    const patches = watchWrites(page, 'PATCH')
    await secondClickOnceOpen(page, edit, 'admin-promotion-dialog')
    await patches.settled()
    expect(patches.sent(), 'PATCHes sent by the double-click').toBe(0)
    await expect(page.getByTestId('admin-promotion-dialog')).toBeVisible()
    await expect(page.getByTestId('admin-promotions-result')).toHaveCount(0)
  })
})

/**
 * Double-clicks the centre of `buttonId`, its second click once the dialog the first opens has finished its opening
 * animation, as a double-click slower than that animation does.
 */
async function secondClickOnceOpen(page: Page, buttonId: string, dialogId: string): Promise<void> {
  const box = await page.getByTestId(buttonId).boundingBox()
  expect(box, `${buttonId} is laid out`).not.toBeNull()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down({ clickCount: 1 })
  await page.mouse.up({ clickCount: 1 })
  const dialog = page.getByTestId(dialogId)
  await expect(dialog).toBeVisible()
  await dialog.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
  await page.mouse.down({ clickCount: 2 })
  await page.mouse.up({ clickCount: 2 })
}

/**
 * Scrolls the page, then sizes the viewport's height, until the open dialog's button lies over `underId`, which the
 * dialog covers, and gives the point of the button above that element's centre.
 */
async function over(
  page: Page,
  dialogId: string,
  buttonId: string,
  underId: string,
): Promise<{ x: number; y: number }> {
  const width = page.viewportSize()!.width
  let found: { x: number; y: number } | null = null
  for (let tries = 0; tries < 6 && found === null; tries += 1) {
    const dialog = page.getByTestId(dialogId)
    await expect(dialog).toBeVisible()
    await dialog.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
    const button = await page.getByTestId(buttonId).boundingBox()
    const under = await page.getByTestId(underId).boundingBox()
    if (button === null || under === null) break
    const cx = under.x + under.width / 2
    const cy = under.y + under.height / 2
    const inside =
      cx > button.x + 2 &&
      cx < button.x + button.width - 2 &&
      cy > button.y + 2 &&
      cy < button.y + button.height - 2
    if (inside) found = { x: cx - button.x, y: cy - button.y }
    else {
      const off = cy - (button.y + button.height / 2)
      const scrolled = await page.evaluate((by) => {
        const before = window.scrollY
        window.scrollBy(0, by)
        return window.scrollY - before
      }, off)
      // What the page could not scroll, the dialog's centre moves by: half of a change in the viewport's height.
      const rest = off - scrolled
      if (Math.abs(rest) > 1) {
        const height = page.viewportSize()!.height + 2 * rest
        await page.setViewportSize({ width, height: Math.max(320, Math.round(height)) })
      }
    }
  }
  expect(found, `${buttonId} lies over ${underId}`).not.toBeNull()
  return found!
}

/** Closes the dialog through its Cancel button. */
async function cancel(page: Page, dialogId: string): Promise<void> {
  await page.getByTestId(dialogId).getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByTestId(dialogId)).toHaveCount(0)
}

/** The dialog and its button lie within the viewport's width, and the button within the dialog's card. */
async function expectInside(
  page: Page,
  dialogId: string,
  buttonId: string,
  width: number,
): Promise<void> {
  const dialog = page.getByTestId(dialogId)
  await expect(dialog).toBeVisible()
  // The dialog zooms in as it opens; its box is its laid-out one only once that has finished.
  await dialog.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
  const card = await dialog.boundingBox()
  const button = await page.getByTestId(buttonId).boundingBox()
  const edges = (box: typeof card) =>
    box === null
      ? { left: Number.NEGATIVE_INFINITY, right: Number.POSITIVE_INFINITY }
      : { left: box.x, right: box.x + box.width }
  const c = edges(card)
  const b = edges(button)
  expect
    .soft(
      {
        dialogInViewport: c.left >= -1 && c.right <= width + 1,
        buttonInViewport: b.left >= -1 && b.right <= width + 1,
        buttonInCard: b.left >= c.left - 1 && b.right <= c.right + 1,
      },
      `${dialogId} at ${width}: card ${c.left} to ${c.right}, ${buttonId} ${b.left} to ${b.right}`,
    )
    .toEqual({ dialogInViewport: true, buttonInViewport: true, buttonInCard: true })
}
