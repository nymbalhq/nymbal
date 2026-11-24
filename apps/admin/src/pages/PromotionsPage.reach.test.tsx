import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryRouter, useLocation, type RouteObject } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '@/components/layout/Sidebar'
import { clearToken, setToken } from '@/lib/auth'
import { fakeShellApi } from '@/tests/admin-shell'
import { JsdomRequest, renderWithProviders } from '@/tests/render'

// What leads a merchant to the promotions page: the sidebar's link, and the admin's own route table rendering the page
// inside the layout at /promotions. The palette's "Go to Promotions" is held with the other pages in
// CommandPalette.test.tsx.

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>
}

afterEach(() => {
  clearToken()
  vi.unstubAllGlobals()
})

describe('the promotions page is reachable', () => {
  // Kills: a page with no sidebar entry, or an entry that goes somewhere else.
  it('AC-9: the sidebar’s Promotions link (admin-nav-promotions) is named Promotions and opens /promotions', async () => {
    fakeShellApi()
    const user = userEvent.setup()
    renderWithProviders(
      <>
        <Sidebar open onClose={() => {}} />
        <Where />
      </>,
      { initialPath: '/orders' },
    )
    const link = screen.getByTestId('admin-nav-promotions')
    expect(link).toHaveAccessibleName(/^Promotions\b/)
    expect(link).toHaveAttribute('href', '/promotions')

    await user.click(link)

    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe(link.getAttribute('href')),
    )
    expect(link).toHaveAttribute('aria-current', 'page')
  })

  // Kills: no route for the page, so /promotions is the not-found page; a route outside the layout; no breadcrumb.
  it('AC-9: the admin’s route table renders the promotions page at /promotions inside the layout, under the breadcrumb "Promotions", with the sidebar’s Promotions link current', async () => {
    fakeShellApi()
    setToken('reach-token')
    vi.stubGlobal('Request', JsdomRequest)
    // Imported here, under the stub: the module builds the browser router, whose first navigation makes a Request.
    const { router } = await import('@/router')
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } },
    })
    const memory = createMemoryRouter(router.routes as RouteObject[], {
      initialEntries: ['/promotions'],
    })
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={memory} />
      </QueryClientProvider>,
    )

    const main = await screen.findByRole('main', undefined, { timeout: 5000 })
    await waitFor(() => expect(main.textContent ?? '').not.toBe(''))
    expect(main.textContent, 'the page at /promotions').not.toContain('Page not found')
    const create = await screen.findByTestId('admin-promotions-new', undefined, { timeout: 5000 })
    expect(main.contains(create), 'the page inside the layout’s main').toBe(true)
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' }).textContent).toBe('Promotions')
    expect(screen.getByTestId('admin-nav-promotions')).toHaveAttribute('aria-current', 'page')
  })
})
