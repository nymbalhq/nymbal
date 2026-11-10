import fc from 'fast-check'
import { DynamicServerError } from 'next/dist/client/components/hooks-server-context'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LoginPage from '@/app/(shopper)/account/login/page'
import { shopperCapabilities } from '@/lib/api'

// The sign-in page asks GET /api/capabilities whether the store confirms sign-ups, to offer the way back to a lost
// confirmation link. That read is an extra: when it fails the page still renders the form, with no link.

// The sign-in form as the server renders it: a form with a password field.
const FORM = /<form[\s>][\s\S]*type="password"/

type Failure = 'network' | number

let answer: () => Response = () => {
  throw new Error('no answer set')
}

const capabilities = (verification: string): Response =>
  new Response(JSON.stringify({ data: { auth: { verification } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const failing = (failure: Failure): (() => Response) =>
  failure === 'network'
    ? () => {
        throw new TypeError('fetch failed')
      }
    : () =>
        new Response(JSON.stringify({ error: { message: 'refused' } }), {
          status: failure,
          headers: { 'content-type': 'application/json' },
        })

/** Every way the capabilities read fails: no answer, or any error status but a 404 (which is an answer). */
const aFailure: fc.Arbitrary<Failure> = fc.oneof(
  fc.constant<Failure>('network'),
  fc.integer({ min: 400, max: 599 }).filter((status) => status !== 404),
)

interface LoginViewProps {
  serverHtml: string
  target: string
  confirmsSignUps: boolean
}

async function renderPage(): Promise<LoginViewProps> {
  const element = (await LoginPage({ searchParams: Promise.resolve({}) })) as {
    props: LoginViewProps
  }
  return element.props
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (new URL(url).pathname !== '/api/capabilities') throw new Error(`unexpected fetch ${url}`)
    return answer()
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the sign-in page when GET /api/capabilities fails', () => {
  it('for every failed capabilities read, the page renders the sign-in form with no confirmation link', async () => {
    await fc.assert(
      fc.asyncProperty(aFailure, async (failure) => {
        answer = failing(failure)
        const props = await renderPage()
        expect(props.serverHtml, `the form on ${failure}`).toMatch(FORM)
        expect(props.confirmsSignUps, `no link on ${failure}`).toBe(false)
      }),
      { numRuns: 30 },
    )
  })

  it('on a 200, the link follows whether the store requires confirmation', async () => {
    for (const verification of ['required', 'off']) {
      answer = () => capabilities(verification)
      const props = await renderPage()
      expect(props.serverHtml).toMatch(FORM)
      expect(props.confirmsSignUps, verification).toBe(verification === 'required')
    }
  })

  it('passes on what Next must see (its dynamic-usage error) rather than falling back', async () => {
    const dynamic = new DynamicServerError('Dynamic server usage: headers')
    answer = () => {
      throw dynamic
    }
    await expect(shopperCapabilities()).rejects.toBe(dynamic)
  })
})
