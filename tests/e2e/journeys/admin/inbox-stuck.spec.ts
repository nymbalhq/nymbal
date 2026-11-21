import type { Page } from '@playwright/test'
import { expect, test } from '../../support/fixtures'
import { ADMIN_EMAIL, ADMIN_PASSWORD } from '../../support/admin'
import { adminToken } from '../../support/checkout'
import { phoneWidths } from '../../support/phone-width'
import { readProposal } from '../../support/proposals'
import {
  INTERRUPTED_CODE,
  INTERRUPTED_TEXT,
  OUTCOME_UNKNOWN_CODE,
  OUTCOME_UNKNOWN_TEXT,
  seedSettledProposal,
  type SettledRow,
} from '../../support/stuck-proposals'

// A proposal the server settled after it stopped reads through the real API and page: the merchant is told when the
// outcome cannot be known, and when it can. The rows are seeded in that settled end state (no product surface yields a
// stuck row), then read and shown as the inbox's Decided tab shows anything else.

async function seedBoth(): Promise<{ unknown: SettledRow; interrupted: SettledRow }> {
  return {
    unknown: await seedSettledProposal('order.refund', OUTCOME_UNKNOWN_CODE, OUTCOME_UNKNOWN_TEXT),
    interrupted: await seedSettledProposal('order.confirm', INTERRUPTED_CODE, INTERRUPTED_TEXT),
  }
}

/** The Decided tab, the API's read of both rows, and each card as the merchant sees it. */
async function expectSettledCards(
  page: Page,
  rows: { unknown: SettledRow; interrupted: SettledRow },
  token: string,
  request: Parameters<typeof readProposal>[0],
): Promise<void> {
  const { unknown, interrupted } = rows
  expect((await readProposal(request, token, unknown.id)).outcome?.code).toBe(OUTCOME_UNKNOWN_CODE)
  expect((await readProposal(request, token, interrupted.id)).outcome?.code).toBe(INTERRUPTED_CODE)

  await page.goto('login')
  await page.getByTestId('admin-login-email').fill(ADMIN_EMAIL)
  await page.getByTestId('admin-login-password').fill(ADMIN_PASSWORD)
  await page.getByTestId('admin-login-submit').click()
  await page.waitForURL((url) => !url.pathname.replace(/\/$/, '').endsWith('/login'), {
    timeout: 15_000,
  })
  await page.goto('inbox')
  await page.getByTestId('admin-inbox-tab-decided').click()

  const unknownCard = page.getByTestId(`admin-inbox-row-${unknown.id}`)
  await expect(page.getByTestId(`admin-inbox-status-${unknown.id}`)).toHaveText('Outcome unknown', {
    timeout: 15_000,
  })
  await expect(unknownCard).toContainText(OUTCOME_UNKNOWN_TEXT)
  await expect(unknownCard.locator(`a[href*="correlation=${unknown.correlationId}"]`)).toHaveCount(1)

  const interruptedCard = page.getByTestId(`admin-inbox-row-${interrupted.id}`)
  await expect(page.getByTestId(`admin-inbox-status-${interrupted.id}`)).toHaveText('Failed')
  await expect(interruptedCard).toContainText(INTERRUPTED_TEXT)

  for (const id of [unknown.id, interrupted.id]) {
    await expect(page.getByTestId(`admin-inbox-approve-${id}`)).toHaveCount(0)
    await expect(page.getByTestId(`admin-inbox-reject-${id}`)).toHaveCount(0)
  }
}

test.describe('Admin inbox: a proposal the server settled after stopping', () => {
  test('AC-15: Decided shows an outcome_unknown row with its badge, message and activity link and an interrupted row reading Failed, and the API answers each code', async ({
    page,
    request,
  }) => {
    const token = await adminToken(request)
    const rows = await seedBoth()
    await expectSettledCards(page, rows, token, request)
  })

  test('AC-15: at a phone’s width the same rows show the same badge and message and the longer message does not widen the page @phone-width', async ({
    page,
    request,
  }) => {
    const token = await adminToken(request)
    const rows = await seedBoth()
    await expectSettledCards(page, rows, token, request)

    const { scrollWidth, innerWidth, viewport, measured } = await phoneWidths(page, 'inbox')
    expect(scrollWidth, measured).toBeLessThanOrEqual(viewport + 1)
    expect(innerWidth, measured).toBe(viewport)
  })
})
