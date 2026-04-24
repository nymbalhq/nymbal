import { vi } from 'vitest'

type MockResponse = {
  body: unknown
  status?: number
  ok?: boolean
}

let mockQueue: MockResponse[] = []
let mockMap: Record<string, unknown> = {}

export function mockFetch(responses: Record<string, unknown>) {
  mockMap = responses
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input)
    const key = Object.keys(mockMap).find((k) => url.includes(k))
    const body = key ? mockMap[key] : { error: { code: 'NOT_FOUND', message: 'Not mocked' } }
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as Response
  })
}

export function mockFetchOnce(response: unknown, status = 200) {
  mockQueue.push({ body: response, status, ok: status >= 200 && status < 300 })
  vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
    const item = mockQueue.shift() ?? { body: {}, status: 200, ok: true }
    return {
      ok: item.ok ?? true,
      status: item.status ?? 200,
      json: async () => item.body,
    } as Response
  })
}

export function clearFetchMocks() {
  mockQueue = []
  mockMap = {}
  vi.restoreAllMocks()
}
