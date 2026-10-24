import type { APIRequestContext } from '@playwright/test'
import { API_URL } from './csrf'

// A journey whose expectation depends on what the store can do reads GET /api/capabilities from API_URL (the native
// store on 3001, or the fixture store on 3011 in the astro-custom and nextjs-custom runs) and asserts the branch the
// report names. It never skips.

export interface StoreCapabilities {
  payments: {
    capabilities: string[]
    client: { driver: string; options: Record<string, string> } | null
  }
  search: { capabilities: string[] }
  catalog: { sortKeys: string[]; defaultSort: string }
}

/** The store's report; a store without the route fails the journey here, naming the answer it gave. */
export async function storeCapabilities(request: APIRequestContext): Promise<StoreCapabilities> {
  const res = await request.get(`${API_URL}/api/capabilities`)
  if (res.status() !== 200) {
    throw new Error(
      `GET ${API_URL}/api/capabilities answered ${res.status()}: ${(await res.text()).slice(0, 200)}`,
    )
  }
  return ((await res.json()) as { data: StoreCapabilities }).data
}

/** The swap runs: their projects are the native ones' names with `-custom`. */
export function isCustomProject(projectName: string): boolean {
  return projectName.endsWith('-custom')
}
