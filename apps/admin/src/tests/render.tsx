import { type ReactElement } from 'react'
import { render, type RenderResult, type RenderOptions } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, RouterProvider, createMemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
      mutations: { retry: false },
    },
  })
}

/** The data router builds a `Request` per navigation with jsdom's AbortSignal, which Node's `Request` refuses, so
 * every navigation would reject. Test routes have no loaders, so the signal is dropped. */
export class JsdomRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    const { signal: _signal, ...rest } = init ?? {}
    super(input, rest)
  }
}

interface RenderWithProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
  initialPath?: string | undefined
  /** Renders the ui as the one `*` route of a memory data router, as the admin's router does, for a page whose hooks
   * need one. Stubs `Request`; the file's `vi.unstubAllGlobals()` undoes it. */
  dataRouter?: boolean | undefined
}

interface RenderWithProvidersResult extends RenderResult {
  queryClient: QueryClient
}

export function renderWithProviders(
  ui: ReactElement,
  { initialPath = '/', dataRouter = false, ...options }: RenderWithProvidersOptions = {},
): RenderWithProvidersResult {
  const queryClient = createTestQueryClient()

  if (dataRouter) {
    vi.stubGlobal('Request', JsdomRequest)
    const router = createMemoryRouter([{ path: '*', element: ui }], {
      initialEntries: [initialPath],
    })
    return {
      ...render(
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
        options,
      ),
      queryClient,
    }
  }

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>{children}</MemoryRouter>
      </QueryClientProvider>
    )
  }

  return {
    ...render(ui, { wrapper: Wrapper, ...options }),
    queryClient,
  }
}
