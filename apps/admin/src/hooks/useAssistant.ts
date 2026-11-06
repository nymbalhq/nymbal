import { create } from 'zustand'
import type { AssistantFrame, AssistantTurnIssued, ProposalView } from '@nymbalhq/types'
import { api, ApiError } from '@/lib/api'

type FrameData<E extends AssistantFrame['event']> = Extract<AssistantFrame, { event: E }>['data']

/** The page characters the turn route takes; a path with any other (a percent-encoded slug) is sent without it. */
const PAGE = /^\/[A-Za-z0-9/_.-]*$/

export type AnswerState = 'streaming' | 'done' | 'stopped' | 'error'

export interface AssistantStep {
  name: string
  title: string
  ok: boolean
  code?: string
}

/** Where in an answer the server revealed a customer's value, and of which kind: offsets into `answer`. */
export type RevealedSpan = NonNullable<FrameData<'text'>['revealed']>[number]

export interface AssistantExchange {
  id: number
  question: string
  answer: string
  /** Sent back with the answer, so the next turn masks those values again. */
  revealed: RevealedSpan[]
  state: AnswerState
  steps: AssistantStep[]
  proposals: ProposalView[]
  error?: { code: string; message: string }
  /** The store has no AI provider that can run the assistant. */
  unavailable?: boolean
}

interface AssistantStore {
  exchanges: AssistantExchange[]
  /** A turn is being sent or streamed: the input is disabled and a second ask is ignored. */
  busy: boolean
  ask(question: string, page: string): void
  /** Stops the turn that streams, if any: its answer so far reads Stopped. */
  stop(): void
  /** A card's proposal as its decision left it. */
  updateProposal(view: ProposalView): void
}

const MAX_TURNS = 40
const MAX_CHARS = 8_000

/** The conversation the server takes: text turns only, at most 40, starting with the user's, the question last. */
function conversationOf(exchanges: AssistantExchange[], question: string) {
  const turns: Array<{
    role: 'user' | 'assistant'
    content: string
    revealed?: RevealedSpan[]
  }> = []
  for (const e of exchanges) {
    turns.push({ role: 'user', content: e.question.slice(0, MAX_CHARS) })
    if (e.answer.trim() !== '') {
      const revealed = e.revealed.filter((s) => s.end <= MAX_CHARS)
      turns.push({
        role: 'assistant',
        content: e.answer.slice(0, MAX_CHARS),
        ...(revealed.length > 0 && { revealed }),
      })
    }
  }
  turns.push({ role: 'user', content: question.slice(0, MAX_CHARS) })
  const recent = turns.slice(-MAX_TURNS)
  while (recent[0]?.role !== 'user') recent.shift()
  return recent
}

function parsed<T>(event: Event): T | undefined {
  try {
    return JSON.parse((event as MessageEvent<string>).data) as T
  } catch {
    return undefined
  }
}

let source: EventSource | null = null
let nextId = 1

export const useAssistant = create<AssistantStore>((set, get) => {
  const patch = (id: number, change: (e: AssistantExchange) => Partial<AssistantExchange>) =>
    set((s) => ({ exchanges: s.exchanges.map((e) => (e.id === id ? { ...e, ...change(e) } : e)) }))

  /** Ends the turn: the stream is closed (so it never reconnects) and the input is free again. */
  const finish = (id: number, change: Partial<AssistantExchange>) => {
    source?.close()
    source = null
    patch(id, () => change)
    set({ busy: false })
  }

  const stream = (id: number, issued: AssistantTurnIssued) => {
    const es = new EventSource(
      `/api/admin/assistant/turns/${encodeURIComponent(issued.turnId)}/stream?ticket=${encodeURIComponent(issued.ticket)}`,
    )
    source = es
    const live = () => source === es
    es.addEventListener('text', (event) => {
      const data = parsed<FrameData<'text'>>(event)
      if (live() && data !== undefined) {
        patch(id, (e) => ({
          answer: e.answer + data.delta,
          revealed: [
            ...e.revealed,
            ...(data.revealed ?? []).map((s) => ({
              ...s,
              start: s.start + e.answer.length,
              end: s.end + e.answer.length,
            })),
          ],
        }))
      }
    })
    es.addEventListener('tool', (event) => {
      const data = parsed<FrameData<'tool'>>(event)
      if (live() && data !== undefined) patch(id, (e) => ({ steps: [...e.steps, data] }))
    })
    es.addEventListener('proposal', (event) => {
      const data = parsed<FrameData<'proposal'>>(event)
      if (live() && data !== undefined) patch(id, (e) => ({ proposals: [...e.proposals, data] }))
    })
    es.addEventListener('done', () => {
      if (live()) finish(id, { state: 'done' })
    })
    // A server `error` frame carries data; the EventSource's own error (a dropped connection) does not.
    es.addEventListener('error', (event) => {
      if (!live()) return
      const data = 'data' in event ? parsed<FrameData<'error'>>(event) : undefined
      finish(id, {
        state: 'error',
        error: data ?? { code: 'assistant.disconnected', message: 'The answer was cut off' },
      })
    })
  }

  return {
    exchanges: [],
    busy: false,

    ask(question, page) {
      const text = question.trim()
      if (text === '' || get().busy) return
      const id = nextId++
      const messages = conversationOf(
        get().exchanges.filter((e) => !e.unavailable),
        text,
      )
      set((s) => ({
        busy: true,
        exchanges: [
          ...s.exchanges,
          {
            id,
            question: text,
            answer: '',
            revealed: [],
            state: 'streaming',
            steps: [],
            proposals: [],
          },
        ],
      }))
      const sent = page.slice(0, 200)
      api
        .post<AssistantTurnIssued>('/api/admin/assistant/turns', {
          messages,
          ...(PAGE.test(sent) && { page: sent }),
        })
        .then((issued) => {
          if (get().exchanges.find((e) => e.id === id)?.state !== 'streaming') return
          stream(id, issued)
        })
        .catch((err: unknown) => {
          const code = err instanceof ApiError ? err.code : 'assistant.failed'
          finish(id, {
            state: 'error',
            ...(code === 'assistant.unavailable' && { unavailable: true }),
            error: {
              code,
              message: err instanceof ApiError ? err.message : 'The question could not be sent',
            },
          })
        })
    },

    stop() {
      const streaming = get().exchanges.find((e) => e.state === 'streaming')
      if (streaming === undefined) return
      finish(streaming.id, { state: 'stopped' })
    },

    updateProposal(view) {
      set((s) => ({
        exchanges: s.exchanges.map((e) => ({
          ...e,
          proposals: e.proposals.map((p) => (p.id === view.id ? view : p)),
        })),
      }))
    },
  }
})
