import { useState } from 'react'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/tests/render'
import { useAssistant } from '@/hooks/useAssistant'
import { AssistantPanel } from './AssistantPanel'

// The Ask panel keeps, with each answer, where in it the server revealed a customer's value and of which kind (the
// `revealed` spans of its `text` frames, offsets into each delta), and sends them back with that answer on the next
// question, so the server can mask those values again. The server is faked at fetch (recording each turn POST) and
// the stream at EventSource: a test plays the frames a turn would send.

interface Span {
  start: number
  end: number
  kind: string
}

interface TextFrame {
  delta: string
  revealed?: Span[]
}

/** An EventSource whose frames the test plays: one per turn, in the order the panel opened them. */
class ScriptedSource {
  static opened: ScriptedSource[] = []
  private readonly listeners = new Map<string, Array<(event: Event) => void>>()

  constructor(readonly url: string) {
    ScriptedSource.opened.push(this)
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close() {}

  play(event: string, data: unknown) {
    const message = new MessageEvent(event, { data: JSON.stringify(data) })
    for (const listener of this.listeners.get(event) ?? []) listener(message)
  }
}

function fakeServer() {
  const posted: Array<{ messages: Array<Record<string, unknown>>; page?: string }> = []
  ScriptedSource.opened = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost/')
    if (url.pathname === '/api/csrf') {
      return new Response(JSON.stringify({ data: { token: 'csrf-token' } }), { status: 200 })
    }
    if (url.pathname === '/api/admin/assistant/turns' && init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)) as (typeof posted)[number])
      return new Response(
        JSON.stringify({ data: { turnId: `turn-${posted.length}`, ticket: 't', expiresIn: 60 } }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({ error: { code: 'not_mocked', message: url.pathname } }), {
      status: 404,
    })
  })
  vi.stubGlobal('EventSource', ScriptedSource)
  return { posted }
}

function Panel() {
  const [draft, setDraft] = useState('')
  return <AssistantPanel draft={draft} onDraftChange={setDraft} />
}

/** Asks `question` through the panel's input and plays `frames` on its stream, then done. */
async function askAndAnswer(question: string, frames: TextFrame[]) {
  const opened = ScriptedSource.opened.length
  const input = screen.getByTestId('admin-assistant-input')
  fireEvent.change(input, { target: { value: question } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(ScriptedSource.opened.length).toBe(opened + 1))
  const source = ScriptedSource.opened.at(-1)!
  for (const frame of frames) source.play('text', frame)
  source.play('done', { text: frames.map((f) => f.delta).join(''), steps: 1, proposals: [] })
  await waitFor(() => expect(useAssistant.getState().busy).toBe(false))
  return useAssistant.getState().exchanges.at(-1)! as ReturnType<
    typeof useAssistant.getState
  >['exchanges'][number] & { revealed?: Span[] }
}

/** A frame: text, then a revealed value of `kind` (or none), then text; its span is the value's place in the delta. */
const frameArb = fc
  .record({
    before: fc.constantFrom('', 'Ship to ', 'and ', ', ', 'Order 1042 went to '),
    value: fc.option(
      fc.record({
        text: fc.constantFrom(
          '12 Acacia Road',
          'SW1A 1AA',
          'ada@example.com',
          '+44 7700 900123',
          'Ada',
        ),
        kind: fc.constantFrom('address', 'postcode', 'email', 'phone', 'name'),
      }),
      { nil: undefined },
    ),
    after: fc.constantFrom('', '.', ' today', ', then '),
  })
  .map(({ before, value, after }): { frame: TextFrame; value?: string } => {
    if (value === undefined) return { frame: { delta: `${before}text${after}` } }
    const span = { start: before.length, end: before.length + value.text.length, kind: value.kind }
    return {
      frame: { delta: `${before}${value.text}${after}`, revealed: [span] },
      value: value.text,
    }
  })

const scrollIntoView = Element.prototype.scrollIntoView

beforeEach(() => {
  useAssistant.setState({ exchanges: [], busy: false })
  Element.prototype.scrollIntoView = () => undefined
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Element.prototype.scrollIntoView = scrollIntoView
})

describe('AC-16: the panel keeps what the answer revealed and sends it back', () => {
  it('AC-16: property: for any answer whose text frames carry revealed spans in some of their deltas, the exchange’s revealed spans index its answer (each span’s text the value revealed, by kind), and the next ask POSTs that answer with exactly those spans; an answer that revealed nothing is POSTed as role and content alone', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(frameArb, { minLength: 1, maxLength: 6 }), async (played) => {
        cleanup()
        useAssistant.setState({ exchanges: [], busy: false })
        const server = fakeServer()
        renderWithProviders(<Panel />, { initialPath: '/orders' })

        const exchange = await askAndAnswer(
          'Where did order 1042 go?',
          played.map((p) => p.frame),
        )
        await askAndAnswer('And then?', [{ delta: 'Nothing more.' }])

        const values: Array<{ text: string; kind: string }> = []
        const expected: Span[] = []
        let offset = 0
        for (const { frame, value } of played) {
          for (const s of frame.revealed ?? []) {
            expected.push({ start: offset + s.start, end: offset + s.end, kind: s.kind })
            values.push({ text: value!, kind: s.kind })
          }
          offset += frame.delta.length
        }
        expect(exchange.answer).toBe(played.map((p) => p.frame.delta).join(''))
        expect(exchange.revealed).toEqual(expected)
        expect(
          (exchange.revealed ?? []).map((s) => ({
            text: exchange.answer.slice(s.start, s.end),
            kind: s.kind,
          })),
        ).toEqual(values)

        expect(server.posted.length).toBe(2)
        expect(server.posted[1]!.messages[1]).toEqual({
          role: 'assistant',
          content: exchange.answer,
          ...(expected.length > 0 && { revealed: expected }),
        })
      }),
      { numRuns: 20 },
    )
  }, 60_000)

  it('AC-16: an answer cut at 8 000 characters is sent with only the spans that end within the cut: one ending at 8 000 is kept, one across the cut and one after it are dropped', async () => {
    const server = fakeServer()
    renderWithProviders(<Panel />, { initialPath: '/orders' })
    const name = { start: 8, end: 11, kind: 'name' }
    // First answer: a name, filler, then a street line across the cut and a postcode after it.
    const across = await askAndAnswer('Who and where?', [
      { delta: 'Ship to Ada', revealed: [name] },
      { delta: 'x'.repeat(7980) },
      { delta: ' 12 Acacia Road', revealed: [{ start: 1, end: 15, kind: 'address' }] },
      { delta: ', SW1A 1AA.', revealed: [{ start: 2, end: 10, kind: 'postcode' }] },
    ])
    // Second answer: a postcode ending exactly at the cut.
    const atCut = await askAndAnswer('And the postcode?', [
      {
        delta: `${'y'.repeat(7992)}SW1A 1AA`,
        revealed: [{ start: 7992, end: 8000, kind: 'postcode' }],
      },
      { delta: ' it is.' },
    ])

    await askAndAnswer('Thanks.', [{ delta: 'You are welcome.' }])

    const sent = server.posted[2]!.messages
    expect(across.answer.length).toBeGreaterThan(8000)
    expect(across.revealed?.length).toBe(3)
    expect(sent[1]).toEqual({
      role: 'assistant',
      content: across.answer.slice(0, 8000),
      revealed: [name],
    })
    expect(sent[3]).toEqual({
      role: 'assistant',
      content: atCut.answer.slice(0, 8000),
      revealed: atCut.revealed,
    })
    expect(atCut.revealed).toEqual([{ start: 7992, end: 8000, kind: 'postcode' }])
  })
})
