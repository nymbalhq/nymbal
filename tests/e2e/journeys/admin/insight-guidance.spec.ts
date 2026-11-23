import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from '../../support/fixtures'
import { signInAsAdmin } from '../../support/admin'
import { adminToken } from '../../support/checkout'
import { API_URL } from '../../support/csrf'
import { seedInsight } from '../../support/insights'

// AI guidance in the night shift's brief, through the real API and page: one insight seeded with guidance written and
// one with guidance withheld, as a night's guidance pass leaves them, read as `GET /api/admin/insights` answers them.
// The store may add cards of its own, so cards are found by id, never by a count or a position.

test.describe.configure({ mode: 'default' })

const LABEL = 'written by AI'
const WITHHELD = "AI guidance was withheld: it did not pass the store's checks."

interface Listed {
  id: string
  summary: string
  guidance: string | null
  guidanceWithheld: boolean
}

const today = () => new Date().toISOString().slice(0, 10)

async function listed(request: APIRequestContext, token: string): Promise<Listed[]> {
  const res = await request.get(`${API_URL}/api/admin/insights`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.status(), `GET /api/admin/insights: ${await res.text()}`).toBe(200)
  return ((await res.json()) as { data: { items: Listed[] } }).data.items
}

const card = (page: Page, id: string) => page.getByTestId(`admin-inbox-insight-${id}`)
const guidanceOf = (page: Page, id: string) =>
  page.getByTestId(`admin-inbox-insight-guidance-${id}`)
const withheldOf = (page: Page, id: string) =>
  page.getByTestId(`admin-inbox-insight-guidance-withheld-${id}`)

/** Where the card's sentence and its guidance stand in the card's text; -1 for one it does not hold. */
async function placeInCard(page: Page, id: string, summary: string, guidance: string) {
  const text = (await card(page, id).textContent()) ?? ''
  return { summary: text.indexOf(summary), guidance: text.indexOf(guidance) }
}

test.describe('Admin inbox: AI guidance on the night shift brief', () => {
  // Kills: a brief that drops the guidance the API answers, shows it unlabelled or above the sentence, or shows a
  // withheld insight's guidance.
  test('AC-12: an insight with guidance shows the text the API answers under its sentence, labelled as written by AI; a withheld one shows the withheld line and its sentence; Dismiss on either removes its card', async ({
    page,
    request,
  }) => {
    const token = await adminToken(request)
    const day = today()
    const written = await seedInsight({
      severity: 'warning',
      summary: 'Nobody found the tartan scarves yesterday.',
      day,
      guidance: 'Add a tartan scarf to the catalogue, or point the term at the wool scarves.',
      guidanceStatus: 'written',
    })
    const withheld = await seedInsight({
      severity: 'info',
      summary: 'Nobody found the plaid shawls yesterday.',
      day,
      guidance: null,
      guidanceStatus: 'withheld',
    })
    const answered = await listed(request, token)
    const shown = answered.find((i) => i.id === written)!
    const held = answered.find((i) => i.id === withheld)!
    expect([shown.guidanceWithheld, held.guidance, held.guidanceWithheld]).toEqual([
      false,
      null,
      true,
    ])

    await signInAsAdmin(page)
    await page.goto('inbox')
    await expect(card(page, written)).toHaveCount(1, { timeout: 15_000 })
    await expect(card(page, withheld)).toHaveCount(1)

    await expect(guidanceOf(page, written)).toContainText(shown.guidance!)
    await expect(guidanceOf(page, written)).toContainText(LABEL)
    await expect(withheldOf(page, written)).toHaveCount(0)
    const place = await placeInCard(page, written, shown.summary, shown.guidance!)
    expect(place.summary, 'the sentence is on the card').toBeGreaterThanOrEqual(0)
    expect(place.summary, 'the guidance is under the sentence').toBeLessThan(place.guidance)

    await expect(withheldOf(page, withheld)).toHaveText(WITHHELD)
    await expect(card(page, withheld)).toContainText(held.summary)
    await expect(guidanceOf(page, withheld)).toHaveCount(0)

    for (const id of [written, withheld]) {
      await page.getByTestId(`admin-inbox-dismiss-${id}`).click()
      await expect(card(page, id)).toHaveCount(0, { timeout: 15_000 })
    }
    const after = (await listed(request, token)).map((i) => i.id)
    expect(after.filter((id) => id === written || id === withheld)).toEqual([])
  })
})
