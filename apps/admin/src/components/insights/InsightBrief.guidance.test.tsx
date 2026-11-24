import fc from 'fast-check'
import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InsightView } from '@nymbalhq/types'
import { renderWithProviders } from '@/tests/render'
import { InsightBrief } from './InsightBrief'

// The AI guidance under an insight's sentence in the brief, against a fake admin API (fetch stubbed) that answers
// `GET /api/admin/insights` with the views the test gives: the block labelled as written by AI when `guidance` is
// set, the withheld line when `guidanceWithheld`, neither otherwise, and model text always shown as text.

const AT = '2026-11-21T03:30:00.000Z'
const LABEL = 'Suggested next step · written by AI'
const WITHHELD = "AI guidance was withheld: it did not pass the store's checks."

type State = { kind: 'written'; text: string } | { kind: 'withheld' } | { kind: 'none' }

function insight(id: string, state: State): InsightView {
  return {
    id,
    job: 'zero-result-term',
    subject: `term:${id}`,
    day: '2026-11-21',
    dataDay: '2026-11-20',
    severity: 'info',
    summary: `Nobody found ${id}.`,
    facts: { searches: 3 },
    status: 'open',
    createdAt: AT,
    dismissedAt: null,
    guidance: state.kind === 'written' ? state.text : null,
    guidanceWithheld: state.kind === 'withheld',
  }
}

function serve(items: InsightView[]): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost/')
    if (url.pathname === '/api/csrf') return new Response(JSON.stringify({ data: { token: 't' } }))
    if (url.pathname === '/api/admin/insights') {
      return new Response(JSON.stringify({ data: { items } }))
    }
    return new Response(JSON.stringify({ error: { code: 'not_mocked', message: url.pathname } }), {
      status: 404,
    })
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const guidanceId = (id: string) => `admin-inbox-insight-guidance-${id}`
const withheldId = (id: string) => `admin-inbox-insight-guidance-withheld-${id}`

/** Which of the two guidance elements a card holds, and the text each shows. */
function shownOn(id: string): { guidance: string | null; withheld: string | null } {
  const card = screen.getByTestId(`admin-inbox-insight-${id}`)
  const block = card.querySelector(`[data-testid="${guidanceId(id)}"]`)
  const line = card.querySelector(`[data-testid="${withheldId(id)}"]`)
  return { guidance: block?.textContent ?? null, withheld: line?.textContent ?? null }
}

const stateArb: fc.Arbitrary<State> = fc.oneof(
  fc.record({
    kind: fc.constant('written' as const),
    text: fc.string({ minLength: 1, maxLength: 120 }).filter((s) => s.trim() !== ''),
  }),
  fc.constant({ kind: 'withheld' as const }),
  fc.constant({ kind: 'none' as const }),
)

describe('AC-11: the card shows guidance as AI-written text, the withheld line, or neither', () => {
  it('AC-11: property: a card with guidance holds the labelled block with the text and no withheld line; a withheld one holds the line alone; any other holds neither; each under its own sentence', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stateArb, { minLength: 1, maxLength: 4 }), async (states) => {
        const items = states.map((state, n) => insight(`ins${n}`, state))
        serve(items)
        try {
          renderWithProviders(<InsightBrief />)
          await screen.findByTestId(`admin-inbox-insight-${items[0]!.id}`, undefined, {
            timeout: 5000,
          })

          const seen = states.map((state, n) => {
            const id = items[n]!.id
            const shown = shownOn(id)
            const text = screen.getByTestId(`admin-inbox-insight-${id}`).textContent ?? ''
            return {
              summary: text.includes(items[n]!.summary),
              block:
                shown.guidance === null
                  ? null
                  : {
                      labelled: shown.guidance.includes(LABEL),
                      text: state.kind === 'written' && shown.guidance.includes(state.text),
                    },
              withheld: shown.withheld,
              labelOnCard: text.includes(LABEL),
            }
          })

          expect(seen).toEqual(
            states.map((state) => ({
              summary: true,
              block: state.kind === 'written' ? { labelled: true, text: true } : null,
              withheld: state.kind === 'withheld' ? WITHHELD : null,
              labelOnCard: state.kind === 'written',
            })),
          )
        } finally {
          cleanup()
          vi.unstubAllGlobals()
        }
      }),
      { numRuns: 10 },
    )
  }, 60_000)

  it('AC-11: guidance of <img src=x onerror=…> is shown as those characters, and no element is made of it', async () => {
    const markup = '<img src=x onerror="window.__pwned = true"><b>bold</b>'
    serve([insight('ins-x', { kind: 'written', text: markup })])
    renderWithProviders(<InsightBrief />)
    await screen.findByTestId('admin-inbox-insight-ins-x', undefined, { timeout: 5000 })

    const block = screen.getByTestId(guidanceId('ins-x'))

    expect(block.textContent).toContain(markup)
    expect(block.querySelectorAll('img, b')).toHaveLength(0)
    expect((window as { __pwned?: boolean }).__pwned).toBeUndefined()
  })

  it('AC-11: the guidance block comes after the sentence in the card', async () => {
    serve([insight('ins-o', { kind: 'written', text: 'Add a tartan scarf to the catalogue.' })])
    renderWithProviders(<InsightBrief />)
    await screen.findByTestId('admin-inbox-insight-ins-o', undefined, { timeout: 5000 })

    const card = screen.getByTestId('admin-inbox-insight-ins-o')
    const text = card.textContent ?? ''

    expect(text.indexOf('Nobody found ins-o.')).toBeLessThan(text.indexOf('Add a tartan scarf'))
    expect(text.indexOf('Nobody found ins-o.')).toBeGreaterThanOrEqual(0)
  })
})
