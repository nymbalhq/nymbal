import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from '../../support/fixtures'
import { appliedEntries } from '../../support/activity'
import { realtimeConnected, signInAsAdmin, watchRealtime } from '../../support/admin'
import { adminToken } from '../../support/checkout'
import { API_URL, csrf } from '../../support/csrf'
import { seedInsight, type Severity } from '../../support/insights'

// The night shift's brief at the top of the Inbox, through the real API and page: open insights seeded as a night
// leaves them, read as `GET /api/admin/insights` answers them, and dismissed from the card or by another admin's
// request. The store runs its own night about five minutes after it starts and may add cards of its own, so cards are
// found by id and compared by their order on the page, never by a count or a position.

test.describe.configure({ mode: 'default' })

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
}

interface Listed {
  id: string
  severity: Severity
  summary: string
}

const today = () => new Date().toISOString().slice(0, 10)

async function listed(request: APIRequestContext, token: string): Promise<Listed[]> {
  const res = await request.get(`${API_URL}/api/admin/insights`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.status(), `GET /api/admin/insights: ${await res.text()}`).toBe(200)
  return ((await res.json()) as { data: { items: Listed[] } }).data.items
}

async function dismissByRequest(request: APIRequestContext, token: string, id: string) {
  const res = await request.post(`${API_URL}/api/admin/insights/${id}/dismiss`, {
    headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
  })
  expect(res.status(), `POST /api/admin/insights/${id}/dismiss: ${await res.text()}`).toBe(200)
}

async function adminUserId(request: APIRequestContext, token: string): Promise<string> {
  const res = await request.get(`${API_URL}/api/admin/me`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.status(), `GET /api/admin/me: ${await res.text()}`).toBe(200)
  return ((await res.json()) as { data: { userId: string } }).data.userId
}

/** Where each card stands among the page's elements, in document order; -1 for a card not on the page. */
async function documentOrder(page: Page, ids: string[]): Promise<number[]> {
  return page.evaluate((testIds) => {
    const all = Array.from(document.querySelectorAll('[data-testid]')).map((el) =>
      el.getAttribute('data-testid'),
    )
    return testIds.map((id) => all.indexOf(`admin-inbox-insight-${id}`))
  }, ids)
}

const card = (page: Page, id: string) => page.getByTestId(`admin-inbox-insight-${id}`)

test.describe('Admin inbox: the night shift brief', () => {
  // Kills: a brief not wired to the route, one that lists dismissed rows, shows a row twice, or re-sorts.
  test('AC-12: of four seeded insights with the fourth dismissed, each open one has one card, critical before warning before info, each with the summary and severity the API answers, and the dismissed one has none', async ({
    page,
    request,
  }) => {
    const token = await adminToken(request)
    const day = today()
    const critical = await seedInsight({
      severity: 'critical',
      summary: 'Checkout failed 9 times.',
      day,
    })
    const warning = await seedInsight({
      severity: 'warning',
      summary: 'Wool socks run out in 4 days.',
      day,
    })
    const info = await seedInsight({ severity: 'info', summary: 'Nothing matched "tartan".', day })
    const dismissed = await seedInsight({
      severity: 'info',
      summary: 'Nothing matched "plaid".',
      day,
    })
    await dismissByRequest(request, token, dismissed)
    const answered = await listed(request, token)

    await signInAsAdmin(page)
    await page.goto('inbox')
    for (const id of [critical, warning, info]) {
      await expect(card(page, id)).toHaveCount(1, { timeout: 15_000 })
      const item = answered.find((i) => i.id === id)!
      await expect(card(page, id)).toContainText(item.summary)
      await expect(page.getByTestId(`admin-inbox-insight-severity-${id}`)).toHaveText(
        SEVERITY_LABEL[item.severity],
      )
    }
    await expect(card(page, dismissed)).toHaveCount(0)

    const [c, w, i] = await documentOrder(page, [critical, warning, info])
    expect(c, 'critical before warning').toBeLessThan(w!)
    expect(w, 'warning before info').toBeLessThan(i!)
    expect(answered.map((x) => x.id)).not.toContain(dismissed)
  })

  // Kills: a Dismiss that is not guarded against a double click, and a brief that needs a reload to hear another
  // admin's dismiss.
  test('AC-13: a double-clicked Dismiss leaves one applied insight.dismiss entry by the admin, the card gone and gone after a reload, and the API without it; a second insight dismissed by another request leaves the open page without a reload', async ({
    page,
    request,
  }) => {
    const token = await adminToken(request)
    const me = await adminUserId(request, token)
    const day = today()
    const first = await seedInsight({
      severity: 'warning',
      summary: 'Linen shirt runs out in 3 days.',
      day,
    })
    const second = await seedInsight({
      severity: 'info',
      summary: 'Nothing matched "seersucker".',
      day,
    })

    await watchRealtime(page)
    await signInAsAdmin(page)
    await page.goto('inbox')
    await realtimeConnected(page)
    await expect(card(page, first)).toHaveCount(1, { timeout: 15_000 })

    let posts = 0
    page.on('request', (r) => {
      if (
        r.method() === 'POST' &&
        new URL(r.url()).pathname.endsWith(`/insights/${first}/dismiss`)
      ) {
        posts += 1
      }
    })
    await page.getByTestId(`admin-inbox-dismiss-${first}`).dblclick()
    await expect(card(page, first)).toHaveCount(0, { timeout: 15_000 })
    expect(posts, 'dismiss POSTs').toBe(1)

    expect(await appliedEntries(request, token, 'insight.dismiss', first)).toEqual([
      { kind: 'admin', id: me },
    ])
    expect((await listed(request, token)).map((i) => i.id)).not.toContain(first)
    await page.reload()
    await expect(card(page, second)).toHaveCount(1, { timeout: 15_000 })
    await expect(card(page, first)).toHaveCount(0)

    await realtimeConnected(page)
    await dismissByRequest(request, token, second)
    await expect(card(page, second)).toHaveCount(0, { timeout: 15_000 })
  })
})
