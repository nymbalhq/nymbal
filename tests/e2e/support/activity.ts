import type { APIRequestContext } from '@playwright/test'
import { API_URL } from './csrf'
import { expect } from './fixtures'

export interface Actor {
  kind: string
  id: string
}

/**
 * The actors of the applied entries Activity lists for `command` on the subject `subjectId`, newest first: what the
 * store did, read once every request that could add one has been answered.
 */
export async function appliedEntries(
  request: APIRequestContext,
  token: string,
  command: string,
  subjectId: string,
): Promise<Actor[]> {
  const query = new URLSearchParams({ command, subject: subjectId, outcome: 'applied' })
  const res = await request.get(`${API_URL}/api/admin/activity?${query.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.ok(), `GET /api/admin/activity?${query.toString()}: ${await res.text()}`).toBe(true)
  return ((await res.json()) as { data: Array<{ actor: Actor }> }).data.map((e) => e.actor)
}
