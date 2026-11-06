import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from '../../support/fixtures'
import { realtimeConnected, signInAsAdmin, watchRealtime } from '../../support/admin'
import { adminToken } from '../../support/checkout'
import { API_URL, csrf } from '../../support/csrf'
import {
  AGENT,
  pendingCount,
  productStatus,
  proposeProduct,
  readProposal,
} from '../../support/proposals'

// An agent signed in as the store's admin asks for a write over MCP; the merchant sees it arrive in the inbox without a
// reload and approves or rejects it once, however often the button is clicked. The journeys share the pending count,
// so they run one after another.

test.describe.configure({ mode: 'default' })

interface ActivityEntry {
  command: string
  outcome: string
  actor: { kind: string; id: string }
  correlationId: string | null
}

async function activity(
  request: APIRequestContext,
  token: string,
  query: Record<string, string>,
): Promise<ActivityEntry[]> {
  const res = await request.get(`${API_URL}/api/admin/activity?${new URLSearchParams(query)}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.status(), `GET /api/admin/activity: ${await res.text()}`).toBe(200)
  return ((await res.json()) as { data: ActivityEntry[] }).data
}

async function adminUserId(request: APIRequestContext, token: string): Promise<string> {
  const res = await request.get(`${API_URL}/api/admin/me`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.status(), `GET /api/admin/me: ${await res.text()}`).toBe(200)
  return ((await res.json()) as { data: { userId: string } }).data.userId
}

/** The POSTs the page sends to `pattern`, with the correlation id each answer carried; `settled()` waits for all. */
function watchPosts(
  page: Page,
  pattern: RegExp,
): { sent(): number; correlations: string[]; settled(): Promise<void> } {
  let sent = 0
  let answered = 0
  const correlations: string[] = []
  const matches = (r: { method(): string; url(): string }) =>
    r.method() === 'POST' && pattern.test(new URL(r.url()).pathname)
  page.on('request', (r) => {
    if (matches(r)) sent += 1
  })
  page.on('response', (r) => {
    if (!matches(r.request())) return
    const id = r.headers()['x-correlation-id']
    if (id !== undefined) correlations.push(id)
  })
  const onAnswered = (r: { method(): string; url(): string }) => {
    if (matches(r)) answered += 1
  }
  page.on('requestfinished', onAnswered)
  page.on('requestfailed', onAnswered)
  return {
    sent: () => sent,
    correlations,
    async settled() {
      await expect.poll(() => sent - answered, { message: 'POSTs still in flight' }).toBe(0)
    },
  }
}

/** Signs in, opens the inbox on its Pending tab, and waits for the live connection. */
async function openInbox(page: Page): Promise<void> {
  await watchRealtime(page)
  await signInAsAdmin(page)
  await page.goto('inbox')
  await page.getByTestId('admin-inbox-tab-pending').click()
  await realtimeConnected(page)
}

test.describe('Admin inbox: agent proposals', () => {
  // Kills: an inbox that does not listen for proposal.* (the row needs a reload), a count that is not refreshed, a
  // store that changes when an agent proposes.
  test("AC-15: an agent's admin_products_create over POST /api/mcp appears in the open inbox without a reload, showing product.create, the agent and the arguments; the inbox count rises by one and the product does not exist", async ({
    page,
    request,
  }) => {
    const token = await adminToken(request)
    // At least one pending proposal, so the count is shown before the one this journey watches arrive.
    await proposeProduct(request, token)
    await openInbox(page)
    const count = page.getByTestId('admin-inbox-count')
    const before = await pendingCount(request, token)
    await expect(count).toHaveText(String(before), { timeout: 15_000 })

    const proposed = await proposeProduct(request, token)

    const row = page.getByTestId(`admin-inbox-row-${proposed.id}`)
    await expect(row).toContainText('product.create', { timeout: 15_000 })
    await expect(row).toContainText(AGENT.name)
    await expect(row).toContainText(proposed.slug)
    await expect(row).toContainText(proposed.name)
    await expect(count).toHaveText(String(before + 1), { timeout: 15_000 })
    expect(await productStatus(request, token, proposed.slug)).toBe(404)
  })

  // Kills: an Approve that is not disabled or de-duplicated while in flight, so two clicks run the command twice.
  test('AC-16: a double-clicked Approve runs the command once: one product, one product.create entry under the proposal’s correlation id by the signed-in admin, the row reads Applied and the inbox count falls by one', async ({
    page,
    request,
  }) => {
    const token = await adminToken(request)
    const me = await adminUserId(request, token)
    // Two pending, so the count still shows once this one is decided.
    await proposeProduct(request, token)
    const proposed = await proposeProduct(request, token)
    await openInbox(page)
    const count = page.getByTestId('admin-inbox-count')
    const before = await pendingCount(request, token)
    await expect(count).toHaveText(String(before), { timeout: 15_000 })
    await expect(page.getByTestId(`admin-inbox-row-${proposed.id}`)).toContainText(proposed.slug, {
      timeout: 15_000,
    })

    const posts = watchPosts(page, /^\/api\/admin\/proposals\/[^/]+\/approve$/)
    await page.getByTestId(`admin-inbox-approve-${proposed.id}`).dblclick()
    await posts.settled()

    const read = await readProposal(request, token, proposed.id)
    const created = await activity(request, token, {
      correlation: read.correlationId,
      command: 'product.create',
    })
    expect(read.status, `${posts.sent()} approve POSTs sent`).toBe('applied')
    expect(await productStatus(request, token, proposed.slug)).toBe(200)
    expect(
      created.filter((e) => e.outcome === 'applied').map((e) => e.actor),
      `${posts.sent()} approve POSTs sent`,
    ).toEqual([{ kind: 'admin', id: me }])
    await expect(count).toHaveText(String(before - 1), { timeout: 15_000 })
    await page.getByTestId('admin-inbox-tab-decided').click()
    await expect(page.getByTestId(`admin-inbox-status-${proposed.id}`)).toHaveText(/applied/i, {
      timeout: 15_000,
    })
  })

  // Kills: a Reject confirm that is not disabled or de-duplicated while in flight.
  test('AC-16: a double-clicked Reject confirm rejects once: exactly one proposal.reject entry applied across the reject POSTs the page sent, and the count falls by one', async ({
    page,
    request,
  }) => {
    const token = await adminToken(request)
    await proposeProduct(request, token)
    const proposed = await proposeProduct(request, token)
    await openInbox(page)
    const count = page.getByTestId('admin-inbox-count')
    const before = await pendingCount(request, token)
    await expect(count).toHaveText(String(before), { timeout: 15_000 })

    const posts = watchPosts(page, /^\/api\/admin\/proposals\/[^/]+\/reject$/)
    await page.getByTestId(`admin-inbox-reject-${proposed.id}`).click()
    await page.getByTestId('admin-inbox-reason').fill('Rejected twice over, once in effect')
    await page.getByTestId('admin-inbox-reject-confirm').dblclick()
    await posts.settled()

    const entries = (
      await Promise.all(
        posts.correlations.map((correlation) =>
          activity(request, token, { correlation, command: 'proposal.reject' }),
        ),
      )
    ).flat()
    expect(
      entries.filter((e) => e.outcome === 'applied'),
      `${posts.sent()} reject POSTs sent`,
    ).toHaveLength(1)
    expect(posts.correlations).toHaveLength(posts.sent())
    expect((await readProposal(request, token, proposed.id)).status).toBe('rejected')
    await expect(count).toHaveText(String(before - 1), { timeout: 15_000 })
  })

  // Kills: a reason that is lost, a rejected proposal that still applies.
  test('AC-17: Reject with a reason moves the row to Decided reading Rejected with that reason; the product does not exist, and an approve afterwards answers 409', async ({
    page,
    request,
  }) => {
    const token = await adminToken(request)
    const proposed = await proposeProduct(request, token)
    const reason = 'Out of season until the spring range'
    await openInbox(page)
    await expect(page.getByTestId(`admin-inbox-row-${proposed.id}`)).toContainText(proposed.slug, {
      timeout: 15_000,
    })

    await page.getByTestId(`admin-inbox-reject-${proposed.id}`).click()
    await page.getByTestId('admin-inbox-reason').fill(reason)
    await page.getByTestId('admin-inbox-reject-confirm').click()

    await expect(page.getByTestId(`admin-inbox-row-${proposed.id}`)).toBeHidden({
      timeout: 15_000,
    })
    await page.getByTestId('admin-inbox-tab-decided').click()
    await expect(page.getByTestId(`admin-inbox-status-${proposed.id}`)).toHaveText(/rejected/i, {
      timeout: 15_000,
    })
    await expect(page.getByTestId(`admin-inbox-row-${proposed.id}`)).toContainText(reason)
    expect(await productStatus(request, token, proposed.slug)).toBe(404)
    const late = await request.post(`${API_URL}/api/admin/proposals/${proposed.id}/approve`, {
      headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
    })
    expect(late.status(), await late.text()).toBe(409)
    expect((await readProposal(request, token, proposed.id)).decision?.reason).toBe(reason)
  })
})
