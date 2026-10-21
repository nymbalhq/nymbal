import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import type { SettingsListing } from '@nymbalhq/types'
import { renderWithProviders } from '@/tests/render'
import { SettingsPage } from './SettingsPage'

// P3-07 (spec P3-07-secrets-settings, diff review W1 and M1): a field's save sends one PUT however fast it is clicked,
// and a refused PUT's message is shown on the page. Kills: a double click saving twice (two `settings.changed`); a
// refusal the admin never sees.

const LISTING: SettingsListing = {
  slots: [
    {
      slot: 'ai',
      provider: 'anthropic',
      fields: [
        {
          path: 'apiKey',
          label: 'API key',
          secret: true,
          state: 'unset',
          source: null,
          updatedAt: null,
        },
      ],
    },
  ],
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

/** The admin API for this page; each PUT is answered when the test calls `answer`. */
function fakeApi(answer: () => Response) {
  const puts: string[] = []
  const pending: Array<() => void> = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost/')
    const method = (init.method ?? 'GET').toUpperCase()
    if (url.pathname === '/api/csrf') return json({ data: { token: 'tok' } })
    if (method === 'PUT' && url.pathname === '/api/admin/settings/ai/apiKey') {
      puts.push(String(init.body))
      return new Promise<Response>((resolve) => pending.push(() => resolve(answer())))
    }
    if (url.pathname === '/api/admin/settings') return json({ data: LISTING })
    return json({ error: { code: 'not_mocked', message: url.pathname } }, 404)
  })
  return {
    puts,
    release: () => {
      for (const resolve of pending.splice(0)) resolve()
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Settings save', () => {
  it('W1: a double click on settings-save-ai-apiKey sends exactly one PUT while the first is in flight', async () => {
    const api = fakeApi(() =>
      json({
        data: { slot: 'ai', path: 'apiKey', state: 'set', source: 'settings', restartRequired: true },
      }),
    )
    renderWithProviders(<SettingsPage />)
    const input = await screen.findByTestId('settings-input-ai-apiKey')
    fireEvent.change(input, { target: { value: 'sk-ant-double-click' } })
    const save = screen.getByTestId('settings-save-ai-apiKey')

    // Two clicks before the page re-renders, as a double click lands.
    fireEvent.click(save)
    fireEvent.click(save)
    fireEvent.doubleClick(save)
    await waitFor(() => expect(api.puts.length).toBeGreaterThan(0))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(api.puts).toEqual([JSON.stringify({ value: 'sk-ant-double-click' })])

    api.release()
    expect(await screen.findByTestId('settings-restart-note')).toBeInTheDocument()
    expect(api.puts.length).toBeLessThan(2)
  })

  it("M1: a PUT refused with 400 shows the API's message, which names the field and the minimum length", async () => {
    const message = 'ai.apiKey is a secret: it needs at least 8 characters'
    const api = fakeApi(() =>
      json({ error: { code: 'settings.secret_too_short', message, context: {} } }, 400),
    )
    renderWithProviders(<SettingsPage />)
    const input = await screen.findByTestId('settings-input-ai-apiKey')
    fireEvent.change(input, { target: { value: 'abc1234' } })
    fireEvent.click(screen.getByTestId('settings-save-ai-apiKey'))
    await waitFor(() => expect(api.puts.length).toBeGreaterThan(0))
    api.release()

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(message)
    expect(alert.textContent).not.toContain('abc1234')
    expect(screen.queryByTestId('settings-restart-note')).toBeNull()
  })
})
