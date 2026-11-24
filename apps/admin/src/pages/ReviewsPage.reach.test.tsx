import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryRouter, useLocation, type RouteObject } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '@/components/layout/Sidebar'
import { clearToken, setToken } from '@/lib/auth'
import { fakeShellApi } from '@/tests/admin-shell'
import { JsdomRequest, renderWithProviders } from '@/tests/render'

// What leads a merchant to the reviews page: the sidebar's link, and the admin's own route table rendering the page
// inside the layout at /reviews. The palette's "Go to Reviews" is held with the other pages in CommandPalette.test.tsx.

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>
}

afterEach(() => {
  clearToken()
  vi.unstubAllGlobals()
})

describe('the reviews page is reachable', () => {
  // Kills: a page with no sidebar entry, or an entry that goes somewhere else.
  it('AC-8: the sidebar’s Reviews link (admin-nav-reviews) is named Reviews and opens /reviews', async () => {
    fakeShellApi()
    const user = userEvent.setup()
    renderWithProviders(
      <>
        <Sidebar open onClose={() => {}} />
        <Where />
      </>,
      { initialPath: '/orders' },
    )
    const link = screen.getByTestId('admin-nav-reviews')
    expect(link).toHaveAccessibleName(/^Reviews\b/)
    expect(link).toHaveAttribute('href', '/reviews')

    await user.click(link)

    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe(link.getAttribute('href')),
    )
    expect(link).toHaveAttribute('aria-current', 'page')
  })

  // Kills: no route for the page, so /reviews is the not-found page; a route outside the layout; no breadcrumb.
  it('AC-8: the admin’s route table renders the reviews page at /reviews inside the layout, under the breadcrumb "Reviews", with the sidebar’s Reviews link current', async () => {
    fakeShellApi()
    setToken('reach-token')
    vi.stubGlobal('Request', JsdomRequest)
    // Imported here, under the stub: the module builds the browser router, whose first navigation makes a Request.
    const { router } = await import('@/router')
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } },
    })
    const memory = createMemoryRouter(router.routes as RouteObject[], {
      initialEntries: ['/reviews'],
    })
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={memory} />
      </QueryClientProvider>,
    )

    const main = await screen.findByRole('main', undefined, { timeout: 5000 })
    await waitFor(() => expect(main.textContent ?? '').not.toBe(''))
    expect(main.textContent, 'the page at /reviews').not.toContain('Page not found')
    const tab = await screen.findByTestId('admin-reviews-tab-pending', undefined, { timeout: 5000 })
    expect(main.contains(tab), 'the page inside the layout’s main').toBe(true)
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' }).textContent).toBe('Reviews')
    expect(screen.getByTestId('admin-nav-reviews')).toHaveAttribute('aria-current', 'page')
  })
})
