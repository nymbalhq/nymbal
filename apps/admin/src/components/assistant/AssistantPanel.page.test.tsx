import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/tests/render'
import { useAssistant } from '@/hooks/useAssistant'
import { AssistantPanel } from './AssistantPanel'

// The Ask panel sends the admin route it was opened on as the turn's `page` only when the path is made of the
// characters the server takes (`^/[A-Za-z0-9/_.-]*$`); a path holding anything else (a percent-encoded slug) sends the
// question without it. The server is faked at fetch and answers as the turn route does, 400 for a page outside that
// set; the EventSource the panel opens for an issued turn is recorded.

const PAGE = /^\/[A-Za-z0-9/_.-]*$/

function fakeServer() {
  const posted: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost/')
    if (url.pathname === '/api/csrf') {
      return new Response(JSON.stringify({ data: { token: 'csrf-token' } }), { status: 200 })
    }
    if (url.pathname === '/api/admin/assistant/turns' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      posted.push(body)
      const page = body['page']
      if (
        page !== undefined &&
        !(typeof page === 'string' && PAGE.test(page) && page.length <= 200)
      ) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'validation.failed',
              message: 'Invalid request',
              context: { issues: [{ path: ['body', 'page'], message: 'Invalid' }] },
            },
          }),
          { status: 400 },
        )
      }
      return new Response(
        JSON.stringify({ data: { turnId: `turn-${posted.length}`, ticket: 't', expiresIn: 60 } }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({ error: { code: 'not_mocked', message: url.pathname } }), {
      status: 404,
    })
  })
  const opened: string[] = []
  vi.stubGlobal(
    'EventSource',
    class {
      constructor(url: string) {
        opened.push(new URL(url, 'http://localhost/').pathname)
      }
      addEventListener() {}
      close() {}
    },
  )
  return { posted, opened }
}

function Panel() {
  const [draft, setDraft] = useState('')
  return <AssistantPanel draft={draft} onDraftChange={setDraft} />
}

async function askOn(path: string) {
  const server = fakeServer()
  renderWithProviders(<Panel />, { initialPath: path })
  const input = screen.getByTestId('admin-assistant-input')
  fireEvent.change(input, { target: { value: 'What does this product cost?' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(server.posted.length).toBe(1))
  return server
}

const scrollIntoView = Element.prototype.scrollIntoView

beforeEach(() => {
  useAssistant.setState({ exchanges: [], busy: false })
  // jsdom lays nothing out; the panel scrolls its last answer into view.
  Element.prototype.scrollIntoView = () => undefined
})

afterEach(() => {
  vi.unstubAllGlobals()
  Element.prototype.scrollIntoView = scrollIntoView
})

describe('AC-10: the panel sends the page only in the characters the server takes', () => {
  it('AC-10: on /products/ceramic-mug the turn POST carries page /products/ceramic-mug; on /products/caf%C3%A9-mug it carries no page, the ask is not refused and its stream opens', async () => {
    const plain = await askOn('/products/ceramic-mug')
    await waitFor(() => expect(plain.opened).toEqual(['/api/admin/assistant/turns/turn-1/stream']))
    expect(plain.posted[0]!['page']).toBe('/products/ceramic-mug')
    cleanup()
    vi.unstubAllGlobals()
    useAssistant.setState({ exchanges: [], busy: false })

    const encoded = await askOn('/products/caf%C3%A9-mug')

    expect(Object.hasOwn(encoded.posted[0]!, 'page')).toBe(false)
    // The same ask as on the plain page, less its page.
    expect(encoded.posted[0]).toEqual(
      Object.fromEntries(Object.entries(plain.posted[0]!).filter(([key]) => key !== 'page')),
    )
    await waitFor(() =>
      expect(encoded.opened).toEqual(['/api/admin/assistant/turns/turn-1/stream']),
    )
    expect(screen.queryByTestId('admin-assistant-error')).toBeNull()
  })
})
