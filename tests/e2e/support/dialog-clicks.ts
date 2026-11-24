import type { Page } from '@playwright/test'
import { ADMIN_EMAIL, ADMIN_PASSWORD } from './admin'
import { expect } from './fixtures'

// Pointer work for the admin's dialogs: a double-click whose clicks land on either side of a dialog opening or closing,
// the point at which a dialog's button covers an element of the page beneath, and whether a dialog fits the viewport.

/** The writes a page sends of `method` to paths under `prefix`; `settled()` waits until each has been answered. */
export function watchWrites(
  page: Page,
  method: string,
  prefix: string,
  path?: (pathname: string) => boolean,
): { sent(): number; settled(): Promise<void> } {
  let sent = 0
  let answered = 0
  const matches = (r: { method(): string; url(): string }) => {
    const pathname = new URL(r.url()).pathname
    return (
      r.method() === method && pathname.startsWith(prefix) && (path === undefined || path(pathname))
    )
  }
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

/** Signs in through the form: the phone's off-canvas sidebar hides the link `signInAsAdmin` waits for. */
export async function signInByForm(page: Page): Promise<void> {
  await page.goto('login')
  await page.getByTestId('admin-login-email').fill(ADMIN_EMAIL)
  await page.getByTestId('admin-login-password').fill(ADMIN_PASSWORD)
  await page.getByTestId('admin-login-submit').click()
  await page.waitForURL((url) => !url.pathname.replace(/\/$/, '').endsWith('/login'), {
    timeout: 15_000,
  })
}

/** Waits for the open dialog's opening animation, after which its box is its laid-out one. */
async function settledDialog(page: Page, dialogId: string): Promise<void> {
  const dialog = page.getByTestId(dialogId)
  await expect(dialog).toBeVisible()
  await dialog.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
}

/**
 * Double-clicks the centre of `buttonId`, its second click once the dialog the first opens has finished its opening
 * animation, as a double-click slower than that animation does.
 */
export async function secondClickOnceOpen(
  page: Page,
  buttonId: string,
  dialogId: string,
): Promise<void> {
  const box = await page.getByTestId(buttonId).boundingBox()
  expect(box, `${buttonId} is laid out`).not.toBeNull()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down({ clickCount: 1 })
  await page.mouse.up({ clickCount: 1 })
  await settledDialog(page, dialogId)
  await page.mouse.down({ clickCount: 2 })
  await page.mouse.up({ clickCount: 2 })
}

/**
 * Scrolls the page, then sizes the viewport's height, until the open dialog's button lies over `underId`, which the
 * dialog covers, and gives the point of the button above that element's centre.
 */
export async function over(
  page: Page,
  dialogId: string,
  buttonId: string,
  underId: string,
): Promise<{ x: number; y: number }> {
  const width = page.viewportSize()!.width
  let found: { x: number; y: number } | null = null
  for (let tries = 0; tries < 6 && found === null; tries += 1) {
    await settledDialog(page, dialogId)
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
export async function cancelDialog(page: Page, dialogId: string): Promise<void> {
  await page.getByTestId(dialogId).getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByTestId(dialogId)).toHaveCount(0)
}

/** The dialog and its button lie within the viewport's width, and the button within the dialog's card. */
export async function expectInside(
  page: Page,
  dialogId: string,
  buttonId: string,
  width: number,
): Promise<void> {
  await settledDialog(page, dialogId)
  const card = await page.getByTestId(dialogId).boundingBox()
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
