import { describe, expect, it } from 'vitest'
import type { CommerceAdapter } from '../adapter/commerce-adapter.js'
import { createSearchStore } from './search-store.js'

// The search store sends `origin` only when a caller gives it, so the page's own search is marked and every other
// search stays the request it always was.

interface Recorded {
  args: unknown[][]
}

function recordingAdapter(): CommerceAdapter & Recorded {
  const args: unknown[][] = []
  return {
    args,
    products: {
      search: async (...call: unknown[]) => {
        args.push(call)
        return { items: [], nextCursor: null, total: 0, facets: [] }
      },
    },
  } as unknown as CommerceAdapter & Recorded
}

const withoutOrigin = (options: unknown): Record<string, unknown> =>
  Object.fromEntries(Object.entries(options as object).filter(([key]) => key !== 'origin'))

describe('AC-31: search store and origin', () => {
  it('AC-31: origin page reaches the adapter beside any category; an unmarked search calls the adapter exactly as today', async () => {
    const adapter = recordingAdapter()
    const store = createSearchStore(adapter)

    await store.search('widget', { origin: 'page' })
    await store.search('widget', { category: 'shoes', origin: 'page' })

    expect(adapter.args).toEqual([
      ['widget', { origin: 'page' }],
      ['widget', { category: 'shoes', origin: 'page' }],
    ])
    await store.search('another')
    await store.search('another', { category: 'shoes' })
    expect(adapter.args.slice(-2)).toEqual([['another'], ['another', { category: 'shoes' }]])
    expect(adapter.args[3]![1]).toStrictEqual(withoutOrigin(adapter.args[1]![1]))
  })
})
