import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  NymbalError,
  type AiAdapter,
  type Caller,
  type ChatMessage,
  type ChatOptions,
  type ChatStreamEvent,
  type ChatToolCall,
  type Logger,
  type ToolDefinition,
  type ToolResult,
  type ToolSurface,
} from '@nymbalhq/types'
import {
  scriptedAi,
  toolMessagesOf,
  type ScriptedRequest,
} from '../../tests/support/scripted-ai.js'
import { runAssistantTurn } from './loop.js'

// The assistant's loop with a turn mask: the model and the tool surface are scripted, the loop is the real one.
// - AC-4: property, whatever deltas a model splits its answer into, the admin sees each minted token as its value, in
//   order, held back only while a delta ends inside what may still become a minted token, and flushed before an error.
// - AC-5: property, calls reach the store with their tokens restored, no request carries a value the turn masked, a long
//   list is cut from its masked form, forged and unminted tokens never become a customer's value, and mask [] or absent
//   sends what the loop sends without masking.
// - AC-6: the conversation: details typed in a question, token-shaped text in it, and an earlier answer's revealed
//   spans reach the model as tokens; a value a later result reveals is masked in every later request.

const DEFAULT_MASK = ['email', 'phone', 'address', 'postcode'] as const

/** The system prompt's line under a non-empty mask, as the Interface words it. */
const MASKED_DATA_RULE =
  "A customer's details may appear as placeholders such as [email-1], [phone-1], [address-1], [postcode-1] or [name-1], each standing for one value: copy a placeholder exactly as written into a tool's arguments or into your answer, and the merchant sees the real value; never guess what it stands for."

const UNKNOWN_PLACEHOLDER = 'assistant.unknown_placeholder'

/** Token-shaped text, as the mask's TOKEN_SOURCE describes it; global here, for counting. */
const SHAPED = /\[(email|phone|address|postcode|name)-([1-9][0-9]*)\]/g

const tool = (
  name: string,
  method: ToolDefinition['route']['method'],
  path: string,
  kind: 'read' | 'command' = 'read',
): ToolDefinition => ({
  name,
  title: name.replaceAll('_', '.'),
  description: name,
  inputSchema: { type: 'object', properties: {} },
  scope: 'admin',
  kind,
  route: { method, path, command: kind === 'command' ? 'product.update' : null },
})

const GET = tool('admin_customers_get', 'GET', '/api/admin/customers/:id')
const SEARCH = tool('admin_customers_list', 'GET', '/api/admin/customers')
// The long list is the admin search, a list the loop sends whole: the orders list reaches the model as summaries.
const ORDERS = tool('admin_search', 'GET', '/api/admin/search')
const ORDER = tool('admin_orders_get', 'GET', '/api/admin/orders/:id')
const REVIEWS = tool('admin_reviews_pending', 'GET', '/api/admin/reviews')
const UPDATE = tool('admin_products_update', 'PATCH', '/api/admin/products/:id', 'command')
const TOOLS = [GET, SEARCH, ORDERS, ORDER, REVIEWS, UPDATE]

const caller: Caller = {
  auth: { userId: 'admin-1', roles: ['admin'] },
  agent: { name: 'nymbal-assistant' },
}

const silent: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
}

interface LogLine {
  obj: Record<string, unknown>
  msg: string | undefined
}

function recordingLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = []
  const at = (obj: unknown, msg?: string) =>
    void lines.push({ obj: (obj ?? {}) as Record<string, unknown>, msg })
  const logger: Logger = {
    trace: at,
    debug: at,
    info: at,
    warn: at,
    error: at,
    child: () => logger,
  }
  return { logger, lines }
}

const resultOf = (structured: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(structured) }],
  structuredContent: structured,
})

interface Frame {
  event: string
  data: Record<string, unknown>
}

interface Span {
  start: number
  end: number
  kind: string
}

type Deps = Parameters<typeof runAssistantTurn>[0]
type TurnMessages = Parameters<typeof runAssistantTurn>[1]['messages']

const textOf = (frames: Frame[]): string =>
  frames
    .filter((f) => f.event === 'text')
    .map((f) => String(f.data['delta']))
    .join('')

/** Each text frame's `revealed` spans, moved to offsets into the frames' concatenation. */
function spansOf(frames: Frame[]): Span[] {
  const out: Span[] = []
  let offset = 0
  for (const f of frames.filter((frame) => frame.event === 'text')) {
    for (const s of (f.data['revealed'] as Span[] | undefined) ?? []) {
      out.push({ start: offset + s.start, end: offset + s.end, kind: s.kind })
    }
    offset += String(f.data['delta']).length
  }
  return out
}

// ─── AC-4 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const VALUES = {
  email: 'ada@example.com',
  phone: '+44 7700 900123',
  address: '12 Acacia Road',
  postcode: 'SW1A 1AA',
} as const

const CUSTOMER = {
  id: 'cus_1',
  email: VALUES.email,
  phone: VALUES.phone,
  firstName: 'Ada',
  lastName: 'Okafor',
  addresses: [{ addressLine1: VALUES.address, postalCode: VALUES.postcode, city: 'London' }],
  orders: 3,
}

/** The tokens one read of CUSTOMER mints under the default mask. */
const MINTED = ['[email-1]', '[phone-1]', '[address-1]', '[postcode-1]']
const MINTED_RE = /\[(email|phone|address|postcode)-1\]/g

/** What reveal is specified to give: each minted token as its value, with the places of the values it put. */
function revealed(text: string): { text: string; spans: Span[] } {
  let out = ''
  let last = 0
  const spans: Span[] = []
  for (const m of text.matchAll(MINTED_RE)) {
    out += text.slice(last, m.index)
    const value = VALUES[m[1] as keyof typeof VALUES]
    spans.push({ start: out.length, end: out.length + value.length, kind: m[1]! })
    out += value
    last = m.index + m[0].length
  }
  return { text: out + text.slice(last), spans }
}

/** The tail of `sent` the revealer may hold: from its last `[`, when that is a proper prefix of a minted token. */
function held(sent: string): string {
  const at = sent.lastIndexOf('[')
  if (at === -1) return ''
  const tail = sent.slice(at)
  return MINTED.some((t) => t.length > tail.length && t.startsWith(tail)) ? tail : ''
}

const answerPart = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...MINTED) },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      '[email-9]',
      '[see note]',
      '[phone-2]',
      '[',
      '[em',
      ']',
      '-1]',
      '[email-',
    ),
  },
  {
    weight: 3,
    arbitrary: fc.string({ unit: fc.constantFrom(...'abc xyz.,-1[]'.split('')), maxLength: 6 }),
  },
  { weight: 2, arbitrary: fc.constantFrom('Order 1042 ', ' was placed by ', ' at ', '. ') },
)

const ENDINGS = ['done', 'failed', 'nymbal-error', 'timeout', 'step-limit', 'stopped'] as const
type Ending = (typeof ENDINGS)[number]

const streamCase = fc
  .array(answerPart, { minLength: 1, maxLength: 12 })
  .map((parts) => parts.join(''))
  .filter((answer) => answer.length > 0)
  .chain((answer) =>
    fc.record({
      answer: fc.constant(answer),
      cuts: fc.uniqueArray(fc.integer({ min: 1, max: Math.max(1, answer.length - 1) }), {
        maxLength: answer.length - 1,
      }),
      ending: fc.constantFrom(...ENDINGS),
      sent: fc.nat(),
    }),
  )
  .map(({ answer, cuts, ending, sent }) => {
    const at = [0, ...cuts.filter((c) => c < answer.length).sort((a, b) => a - b), answer.length]
    const deltas = at.slice(1).map((end, i) => answer.slice(at[i], end))
    const midReply = ending !== 'done' && ending !== 'step-limit'
    return { answer, deltas, ending, sent: midReply ? sent % (deltas.length + 1) : deltas.length }
  })

const READ_CALL: ChatToolCall = { id: 'call_read', name: GET.name, args: { id: CUSTOMER.id } }

/**
 * A model that reads CUSTOMER, then streams `deltas[0..sent)` of its answer and ends as `ending` says. Before each
 * delta and after the last it notes how many frames the loop had emitted, so each delta's own frames can be told apart.
 */
function streamingModel(
  c: { answer: string; deltas: string[]; ending: Ending; sent: number },
  frames: Frame[],
  stop: AbortController,
): { ai: AiAdapter; marks: number[] } {
  const marks: number[] = []
  let requests = 0
  const usage = { inputTokens: 1, outputTokens: 1 }
  const ai = {
    kind: 'ai',
    providerName: 'scripted',
    capabilities: () => ['chat', 'tools', 'stream'],
    producesEvents: [],
    consumesEvents: [],
    async initialize() {},
    async healthCheck() {
      return { status: 'healthy' }
    },
    async embed() {
      throw new Error('not used')
    },
    async complete() {
      throw new Error('not used')
    },
    async chat() {
      throw new Error('the loop streams')
    },
    async *chatStream(
      _messages: readonly ChatMessage[],
      opts?: ChatOptions,
    ): AsyncIterable<ChatStreamEvent> {
      requests += 1
      if (requests === 1) {
        yield { type: 'tool_call', call: READ_CALL }
        yield {
          type: 'done',
          result: { text: '', stopReason: 'tool_use', usage, model: 'm', toolCalls: [READ_CALL] },
        }
        return
      }
      for (const delta of c.deltas.slice(0, c.sent)) {
        marks.push(frames.length)
        yield { type: 'text', delta }
      }
      marks.push(frames.length)
      const aborted = () =>
        new Promise<void>((resolve) => {
          if (opts?.signal?.aborted === true) resolve()
          opts?.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      if (c.ending === 'done' || c.ending === 'step-limit') {
        const toolCalls = c.ending === 'step-limit' ? [READ_CALL] : []
        yield {
          type: 'done',
          result: { text: c.answer, stopReason: 'end', usage, model: 'm', toolCalls },
        }
      } else if (c.ending === 'failed') {
        throw new Error('socket hang up')
      } else if (c.ending === 'nymbal-error') {
        throw new NymbalError(
          'adapter.unavailable',
          'The stream broke after [email-1] and [email-9]',
        )
      } else if (c.ending === 'timeout') {
        await aborted()
      } else {
        stop.abort()
        await aborted()
      }
    },
  } as unknown as AiAdapter
  return { ai, marks }
}

describe('AC-4: the answer streams revealed, held only inside what may become a minted token', () => {
  it('AC-4: property: for any answer of minted tokens and other text split into any deltas, ending done, failed, with an error, by timeout, at the step limit or stopped: the text frames concatenate to the revealed answer (the done text too); after each delta exactly the text before its held tail is out, the tail being a proper prefix of a minted token; a delta with no [ sent with nothing held is its own frame; held text is flushed before the error frame, whose message has minted tokens revealed and others neutralised; the frames’ revealed spans cover exactly the revealed values with their kinds', async () => {
    await fc.assert(
      fc.asyncProperty(streamCase, async (c) => {
        const frames: Frame[] = []
        const stop = new AbortController()
        const model = streamingModel(c, frames, stop)
        const tools: ToolSurface = { list: () => [GET], call: async () => resultOf(CUSTOMER) }

        await runAssistantTurn(
          {
            ai: model.ai,
            tools,
            proposals: { get: async () => null },
            logger: silent,
            mask: [...DEFAULT_MASK],
            limits: {
              ...(c.ending === 'timeout' && { turnMs: 60 }),
              ...(c.ending === 'step-limit' && { maxSteps: 2 }),
            },
          } as Deps,
          { caller, messages: [{ role: 'user', content: 'Who placed order 1042?' }] },
          (frame) => void frames.push(frame as unknown as Frame),
          stop.signal,
        )

        const streamed = c.deltas.slice(0, c.sent).join('')
        const shown = revealed(
          c.ending === 'done' || c.ending === 'step-limit' ? c.answer : streamed,
        )
        expect(textOf(frames)).toBe(shown.text)
        expect(spansOf(frames)).toEqual(shown.spans)
        expect(
          frames.filter(
            (f) =>
              f.event === 'text' &&
              f.data['revealed'] !== undefined &&
              (f.data['revealed'] as Span[]).length === 0,
          ),
        ).toEqual([])

        // After each delta, exactly the text before its held tail is out; a delta with no [ sent while nothing is
        // held is its own frame.
        const steps = c.deltas.slice(0, c.sent).map((delta, i) => {
          const sent = c.deltas.slice(0, i + 1).join('')
          const before = c.deltas.slice(0, i).join('')
          const own = frames
            .slice(model.marks[i], model.marks[i + 1])
            .filter((f) => f.event === 'text')
            .map((f) => f.data['delta'])
          return {
            out: textOf(frames.slice(0, model.marks[i + 1])),
            want: revealed(sent.slice(0, sent.length - held(sent).length)).text,
            whole: held(before) === '' && !delta.includes('['),
            own,
            delta,
          }
        })
        expect(steps.map((s) => s.out)).toEqual(steps.map((s) => s.want))
        const whole = steps.filter((s) => s.whole)
        expect(whole.map((s) => s.own)).toEqual(whole.map((s) => [s.delta]))

        // The turn ends with its done frame, its error frame (after every text frame), or nothing when stopped.
        const CODES = {
          failed: 'assistant.failed',
          'nymbal-error': 'adapter.unavailable',
          timeout: 'assistant.timeout',
          'step-limit': 'assistant.step_limit',
        } as const
        const ended = frames.filter((f) => f.event === 'done' || f.event === 'error')
        const endOf = (f: Frame) =>
          f.event === 'done'
            ? { event: 'done', text: f.data['text'] }
            : {
                event: 'error',
                code: f.data['code'],
                ...(c.ending === 'nymbal-error' && { message: f.data['message'] }),
              }
        expect(ended.map(endOf)).toEqual(
          c.ending === 'stopped'
            ? []
            : c.ending === 'done'
              ? [{ event: 'done', text: shown.text }]
              : [
                  {
                    event: 'error',
                    code: CODES[c.ending],
                    ...(c.ending === 'nymbal-error' && {
                      message: `The stream broke after ${VALUES.email} and [email 9]`,
                    }),
                  },
                ],
        )
        expect(frames.slice(frames.length - ended.length)).toEqual(ended)
        expect(frames.findLastIndex((f) => f.event === 'text')).toBeLessThan(
          frames.length - ended.length,
        )
      }),
      { numRuns: 150 },
    )
  }, 60_000)
})

// ─── AC-5 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Customer {
  id: string
  email: string
  phone: string
  street: string
  postcode: string
  /** A second address line holding quotes, which a JSON result escapes. */
  flat?: string
}

const POSTCODES = ['SW1A 1AA', 'E1 6AN', 'BS1 4DJ']
const STREETS = ['Acacia Road', 'Harbour Lane', 'Mill Street']

const customers = fc
  .array(fc.integer({ min: 10_000, max: 99_999 }), { minLength: 1, maxLength: 3 })
  .map((suffixes) =>
    suffixes.map(
      (n, i): Customer => ({
        id: `cus_${i}`,
        email: `buyer${i}.${n}@shop.io`,
        phone: `+44 7700 9${i}${n}`,
        street: `${10 + i} ${STREETS[i]!}`,
        postcode: POSTCODES[i]!,
        flat: `Flat ${i + 2} "The Mews"`,
      }),
    ),
  )

const customerRecord = (c: Customer) => ({
  id: c.id,
  email: c.email,
  phone: c.phone,
  firstName: 'Ada',
  lastName: 'Okafor',
  addresses: [
    {
      addressLine1: c.street,
      ...(c.flat !== undefined && { addressLine2: c.flat }),
      postalCode: c.postcode,
      city: 'London',
    },
  ],
  orders: 2,
})

/** Twelve orders whose addresses and postcodes are their own, long enough to be cut. */
const ORDER_ITEMS = Array.from({ length: 12 }, (_, j) => ({
  orderNumber: `NYM-${1000 + j}`,
  totalMinor: 1900 + j,
  status: 'paid',
  shippingAddress: {
    firstName: 'Lee',
    lastName: 'Marsh',
    addressLine1: `${j + 1} Filler Street`,
    postalCode: `N${(j % 9) + 1} ${j + 1}QT`,
    city: 'Leeds',
  },
}))
const ORDER_VALUES = ORDER_ITEMS.flatMap((o) => [
  o.shippingAddress.addressLine1,
  o.shippingAddress.postalCode,
])

const REVIEW_BODY = 'Email me at [email-1] about it'
const RESULT_CHARS = 1000

type Call =
  | { kind: 'get'; who: number }
  | { kind: 'search'; who: number; field: 'email' | 'phone' | 'postcode'; wrap: boolean }
  | { kind: 'orders' }
  | { kind: 'note' }
  | { kind: 'reviews' }
  | { kind: 'write'; who: number }
  | { kind: 'forged' }

const callArb: fc.Arbitrary<Call> = fc.oneof(
  fc.record({ kind: fc.constant('get' as const), who: fc.nat(2) }),
  fc.record({
    kind: fc.constant('search' as const),
    who: fc.nat(2),
    field: fc.constantFrom('email' as const, 'phone' as const, 'postcode' as const),
    wrap: fc.boolean(),
  }),
  fc.record({ kind: fc.constant('orders' as const) }),
  fc.record({ kind: fc.constant('reviews' as const) }),
  fc.record({ kind: fc.constant('write' as const), who: fc.nat(2) }),
  fc.record({ kind: fc.constant('forged' as const) }),
)

/**
 * 1-5 replies of 1-4 calls; the first reads an order whose note quotes the first customer's street after a line break
 * and their flat, before any customer is read, then reads the first customer, so `[email-1]` is minted from the start.
 */
const planArb = fc
  .array(fc.array(callArb, { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 5 })
  .map((replies) => {
    let writes = 0
    const capped = replies.map((reply) =>
      reply.map((call): Call => {
        if (call.kind !== 'write') return call
        writes += 1
        return writes > 10 ? { kind: 'orders' } : call
      }),
    )
    return [
      [{ kind: 'note' } as Call, { kind: 'get', who: 0 } as Call, ...capped[0]!],
      ...capped.slice(1),
    ]
  })

/** The surface: answers each call from `people`, and keeps each call's name and arguments as they reached it. */
function storeOf(people: Customer[]) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const answer = (name: string, args: Record<string, unknown>): ToolResult => {
    if (name === GET.name) {
      const found = people.find((p) => p.id === args['id'])
      return found === undefined
        ? {
            ...resultOf({ code: 'customer.not_found', message: 'No such customer' }),
            isError: true,
          }
        : resultOf(customerRecord(found))
    }
    if (name === SEARCH.name) {
      const q = String(args['q'] ?? '')
      const items = people
        .filter((p) => [p.email, p.phone, p.postcode].some((v) => q.includes(v)))
        .map(customerRecord)
      return resultOf({ items, total: items.length })
    }
    if (name === ORDERS.name) return resultOf({ items: ORDER_ITEMS, total: ORDER_ITEMS.length })
    if (name === ORDER.name) {
      const first = people[0]
      return resultOf({
        orderNumber: 'NYM-0999',
        notes: `Leave with the neighbour at\n${first?.street ?? ''}`,
        delivery: `Ring at ${first?.flat ?? ''}`,
      })
    }
    if (name === REVIEWS.name) {
      return resultOf({ items: [{ id: 'rev_1', rating: 1, body: REVIEW_BODY }], total: 1 })
    }
    return resultOf({ id: String(args['id']), updated: true })
  }
  const tools: ToolSurface = {
    list: () => TOOLS,
    call: async (name, args) => {
      const given = structuredClone(args) as Record<string, unknown>
      calls.push({ name, args: given })
      return answer(name, given)
    },
  }
  return { tools, calls }
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** The customer records a request's tool messages hold, by id, as the model reads them. */
function readCustomers(request: ScriptedRequest): Map<string, Record<string, unknown>> {
  const found = new Map<string, Record<string, unknown>>()
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(visit)
    if (typeof node !== 'object' || node === null) return
    const record = node as Record<string, unknown>
    if (typeof record['id'] === 'string' && record['id'].startsWith('cus_')) {
      found.set(record['id'], record)
    }
    Object.values(record).forEach(visit)
  }
  for (const m of request.messages) if (m.role === 'tool') visit(parse(m.content))
  return found
}

const fieldAsRead = (record: Record<string, unknown>, field: 'email' | 'phone' | 'postcode') =>
  field === 'postcode'
    ? String((record['addresses'] as Array<Record<string, unknown>>)[0]!['postalCode'])
    : String(record[field])

interface Planned {
  name: string
  args: Record<string, unknown>
  /** The arguments the store must receive: every token the model copied, as the value it stands for. */
  reaches?: Record<string, unknown>
  forged?: true
}

/**
 * A model that runs `plan` reply by reply, writing each token it uses as it read it in an earlier result, then answers
 * with the first customer's email as read and the review's body as read.
 */
function plannedModel(plan: Call[][], people: Customer[]) {
  const planned: Planned[][] = []
  const model = scriptedAi((request) => {
    const read = readCustomers(request)
    const reply = plan[request.index]
    if (reply === undefined) {
      const first = read.get('cus_0')!
      const review = toolMessagesFor(request)
        .map((m) => parse(m.content) as { items?: Array<{ body?: unknown }> } | undefined)
        .flatMap((v) => v?.items ?? [])
        .find((item) => typeof item.body === 'string' && String(item.body).startsWith('Email me'))
      return {
        text: `Customer ${String(first['email'])} wrote: ${String(review?.body ?? 'nothing')}`,
      }
    }
    const calls = reply.map((call): Planned => {
      const known = 'who' in call ? read.get(people[call.who % people.length]!.id) : undefined
      const person = 'who' in call ? people[call.who % people.length]! : undefined
      if (call.kind === 'search' && known !== undefined && person !== undefined) {
        const token = fieldAsRead(known, call.field)
        const value = person[call.field]
        return {
          name: SEARCH.name,
          args: { q: call.wrap ? `orders for ${token}` : token },
          reaches: { q: call.wrap ? `orders for ${value}` : value },
        }
      }
      if (call.kind === 'write' && known !== undefined && person !== undefined) {
        return {
          name: UPDATE.name,
          args: { id: 'prod_1', description: `Ask ${String(known['email'])}` },
          reaches: { id: 'prod_1', description: `Ask ${person.email}` },
        }
      }
      if (call.kind === 'forged') {
        return {
          name: UPDATE.name,
          args: { id: 'prod_1', description: 'Ask [email-9]' },
          forged: true,
        }
      }
      if (call.kind === 'orders') return { name: ORDERS.name, args: { limit: '50' } }
      if (call.kind === 'note') return { name: ORDER.name, args: { id: 'ord_0' } }
      if (call.kind === 'reviews') return { name: REVIEWS.name, args: {} }
      const id = person?.id ?? 'cus_0'
      return { name: GET.name, args: { id }, reaches: { id } }
    })
    planned.push(calls)
    return { calls: calls.map(({ name, args }) => ({ name, args })) }
  })
  return { ...model, planned }
}

/** Every string in `value`, at any depth. */
const stringsIn = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : typeof value === 'object' && value !== null
      ? Object.values(value).flatMap(stringsIn)
      : []

/** Every text a request's messages hold, a JSON content's strings read unescaped, as the model reads them. */
const textsOf = (request: ScriptedRequest): string[] =>
  request.messages.flatMap((m) => [m.content, ...stringsIn(parse(m.content)), ...stringsIn(m)])

/** Every tool message the request holds. */
const toolMessagesFor = (request: ScriptedRequest) =>
  request.messages.filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool')

/** The values each result held, in call order, that the masked turn must never send. */
function valuesHeld(name: string, args: Record<string, unknown>, people: Customer[]): string[] {
  const ofPerson = (p: Customer) => [
    p.email,
    p.phone,
    p.street,
    p.postcode,
    ...(p.flat === undefined ? [] : [p.flat]),
  ]
  if (name === GET.name) return people.filter((p) => p.id === args['id']).flatMap(ofPerson)
  if (name === SEARCH.name) {
    const q = String(args['q'] ?? '')
    return people
      .filter((p) => [p.email, p.phone, p.postcode].some((v) => q.includes(v)))
      .flatMap(ofPerson)
  }
  if (name === ORDERS.name) return ORDER_VALUES
  return []
}

async function runPlanned(plan: Call[][], people: Customer[], mask: readonly string[] | undefined) {
  const store = storeOf(people)
  const model = plannedModel(plan, people)
  const logs = recordingLogger()
  const frames: Frame[] = []
  await runAssistantTurn(
    {
      ai: model.ai,
      tools: store.tools,
      proposals: { get: async () => null },
      logger: logs.logger,
      limits: { resultChars: RESULT_CHARS },
      ...(mask !== undefined && { mask: [...mask] }),
    } as Deps,
    { caller, messages: [{ role: 'user', content: 'Look into our customers for me.' }] },
    (frame) => void frames.push(frame as unknown as Frame),
  )
  return { store, model, logs, frames }
}

describe('AC-5: what reaches the store and what reaches the provider', () => {
  it('AC-5: property: for any turn of 1-5 replies reading an order note that quotes a customer’s street after a line break and their flat holding quotes before that customer is read, reading customers, searching by tokens read from earlier results (whole or inside a longer string), reading a long list, a review holding [email-1], writing with a token and writing with an unminted [email-9]: each call reaches the store with its tokens restored and the forged ones never run; no request holds a value an earlier result held under a key, in a result’s JSON or in an earlier result’s prose; the long list is cut from its masked form with whole items; the review reaches the model as [email 1] and the answer quoting it shows [email 1]; every request carries MASKED_DATA_RULE; each call line’s masked counts its replacements; under mask [] and with mask absent the turn is the unmasked one (same requests, results as answered, no rule, no masked in the lines)', async () => {
    await fc.assert(
      fc.asyncProperty(customers, planArb, async (people, plan) => {
        const { store, model, logs, frames } = await runPlanned(plan, people, DEFAULT_MASK)
        const planned = model.planned.flat()

        // Each call ran with its tokens restored; a forged one ran nothing.
        expect(store.calls).toEqual(
          planned
            .filter((p) => p.forged !== true)
            .map((p) => ({ name: p.name, args: p.reaches ?? p.args })),
        )

        // No request holds a value any earlier result held under a key, in any of its messages.
        const heldBefore: string[][] = [[]]
        for (const [r, reply] of model.planned.entries()) {
          const ran = reply.filter((p) => p.forged !== true)
          heldBefore[r + 1] = [
            ...heldBefore[r]!,
            ...ran.flatMap((p) => valuesHeld(p.name, p.reaches ?? p.args, people)),
          ]
        }
        for (const [k, request] of model.requests.entries()) {
          const sent = textsOf(request)
          expect(
            heldBefore[k]!.filter((value) => sent.some((text) => text.includes(value))),
          ).toEqual([])
          expect(request.system).toContain(MASKED_DATA_RULE)
        }

        // Each call's answer, in call order, as the model read it in the request after its reply.
        const answers = model.planned.flatMap((reply, r) => {
          const tools = toolMessagesOf(model.requests[r + 1]!)
          expect(tools.length).toBe(reply.length)
          return reply.map((p, i) => ({ planned: p, message: tools[i]! }))
        })
        const contentOf = (text: string) => (parse(text) ?? {}) as Record<string, unknown>
        const itemsOf = (text: string) =>
          (contentOf(text)['items'] ?? []) as Array<Record<string, unknown>>
        // A forged call is answered as refused.
        const forged = answers.filter((a) => a.planned.forged === true)
        expect(
          forged.map((a) => [a.message.isError, contentOf(a.message.content)['code']]),
        ).toEqual(forged.map(() => [true, UNKNOWN_PLACEHOLDER]))
        // The long list is cut, its kept items whole, with a note of how many it left out.
        const lists = answers
          .filter((a) => a.planned.name === ORDERS.name)
          .map((a) => {
            const items = itemsOf(a.message.content)
            return {
              short: items.length < ORDER_ITEMS.length,
              note: String(contentOf(a.message.content)['cut']).startsWith(
                `${ORDER_ITEMS.length - items.length} of ${ORDER_ITEMS.length} items`,
              ),
              keys: items.map((item) => Object.keys(item)),
              whole: ORDER_ITEMS.slice(0, items.length).map((item) => Object.keys(item)),
            }
          })
        expect(lists.map(({ whole: _, ...l }) => l)).toEqual(
          lists.map((l) => ({ short: true, note: true, keys: l.whole })),
        )
        // The review's [email-1] reaches the model neutralised.
        const reviews = answers.filter((a) => a.planned.name === REVIEWS.name)
        expect(reviews.map((a) => itemsOf(a.message.content)[0]?.['body'])).toEqual(
          reviews.map(() => 'Email me at [email 1] about it'),
        )
        expect(
          frames
            .filter((f) => f.event === 'tool' && f.data['code'] === UNKNOWN_PLACEHOLDER)
            .map((f) => [f.data['name'], f.data['ok']]),
        ).toEqual(planned.filter((p) => p.forged === true).map(() => [UPDATE.name, false]))

        // Each call's line counts its replacements: the tokens its result went to the model with (a refusal holds
        // none), for the cut list every address and postcode of its twelve orders, and none for the order note, read
        // before the turn knew the values it quotes.
        const lines = logs.lines.filter((l) => l.msg === 'assistant tool call')
        expect(lines.map((l) => l.obj['masked'])).toEqual(
          answers.map(({ planned: p, message }) =>
            p.name === ORDERS.name
              ? ORDER_VALUES.length
              : p.name === ORDER.name
                ? 0
                : [...message.content.matchAll(SHAPED)].length,
          ),
        )
        expect(lines.map((l) => l.obj['ok'])).toEqual(
          answers.map((a) => a.message.isError !== true),
        )

        // The answer: the email as its value, the review's forged token as it was sent.
        const read = plan.flat().some((c) => c.kind === 'reviews')
        const done = frames.find((f) => f.event === 'done')
        expect(done?.data['text']).toBe(
          `Customer ${people[0]!.email} wrote: ${read ? 'Email me at [email 1] about it' : 'nothing'}`,
        )
        expect(textOf(frames)).toBe(done?.data['text'])

        // Under mask [] and with mask absent the same turn is the unmasked one (a forged write, which would run there,
        // is a review read instead): the same requests, results as the store answered them, no MASKED_DATA_RULE and
        // no masked in the call lines.
        const unforged = plan.map((reply) =>
          reply.map((c): Call => (c.kind === 'forged' ? { kind: 'reviews' } : c)),
        )
        const absent = await runPlanned(unforged, people, undefined)
        const empty = await runPlanned(unforged, people, [])
        expect(empty.model.requests).toEqual(absent.model.requests)
        expect(empty.store.calls).toEqual(absent.store.calls)
        for (const run of [absent, empty]) {
          const answered = await Promise.all(
            run.store.calls.map(
              async (c) =>
                (await storeOf(people).tools.call(c.name, c.args, caller)).content[0]!.text,
            ),
          )
          const sent = run.model.requests
            .slice(1)
            .flatMap((request) => toolMessagesOf(request).map((m) => m.content))
          expect(sent.length).toBe(answered.length)
          expect(
            answered.filter((text, i) => text.length <= RESULT_CHARS && sent[i] !== text),
          ).toEqual([])
          expect(run.model.requests.filter((r) => r.system.includes(MASKED_DATA_RULE))).toEqual([])
          expect(
            run.logs.lines.filter((l) => l.msg === 'assistant tool call' && 'masked' in l.obj),
          ).toEqual([])
          expect(JSON.stringify(run.model.requests.at(-1)!.messages)).toContain(people[0]!.email)
        }
      }),
      { numRuns: 30 },
    )
  }, 180_000)

  it('AC-5: a call holding [phone-1] when the turn minted no phone is not run: is_error assistant.unknown_placeholder, a tool frame ok false with that code, and its line ok false', async () => {
    const store = storeOf([])
    const noPhone = { id: 'cus_9', email: 'ada@example.com', firstName: 'Ada' }
    const tools: ToolSurface = {
      list: () => TOOLS,
      call: async (name, args, ...rest) =>
        name === GET.name ? resultOf(noPhone) : store.tools.call(name, args, ...rest),
    }
    const model = scriptedAi((request) =>
      request.index === 0
        ? { calls: [{ name: GET.name, args: { id: 'cus_9' } }] }
        : request.index === 1
          ? {
              calls: [{ name: UPDATE.name, args: { id: 'prod_1', description: 'Call [phone-1]' } }],
            }
          : { text: 'Done.' },
    )
    const logs = recordingLogger()
    const frames: Frame[] = []

    await runAssistantTurn(
      {
        ai: model.ai,
        tools,
        proposals: { get: async () => null },
        logger: logs.logger,
        mask: [...DEFAULT_MASK],
      } as Deps,
      { caller, messages: [{ role: 'user', content: 'Note their phone on the apron.' }] },
      (frame) => void frames.push(frame as unknown as Frame),
    )

    const [answer] = toolMessagesOf(model.requests[2]!)
    expect(store.calls).toEqual([])
    expect([answer!.isError, (parse(answer!.content) as Record<string, unknown>)['code']]).toEqual([
      true,
      UNKNOWN_PLACEHOLDER,
    ])
    expect(
      frames
        .filter((f) => f.event === 'tool')
        .map((f) => [f.data['name'], f.data['ok'], f.data['code']]),
    ).toEqual([
      [GET.name, true, undefined],
      [UPDATE.name, false, UNKNOWN_PLACEHOLDER],
    ])
    expect(
      logs.lines.filter((l) => l.msg === 'assistant tool call').map((l) => l.obj['ok']),
    ).toEqual([true, false])
  })

  it('AC-5: ten refused calls holding an unminted token take no write slot: the ten writes after them in the same turn all reach the store, each with its token restored', async () => {
    const people: Customer[] = [
      {
        id: 'cus_0',
        email: 'ada@example.com',
        phone: '+44 7700 900123',
        street: '12 Acacia Road',
        postcode: 'SW1A 1AA',
      },
    ]
    const store = storeOf(people)
    const model = scriptedAi((request) => {
      if (request.index === 0) return { calls: [{ name: GET.name, args: { id: 'cus_0' } }] }
      const token = String(readCustomers(request).get('cus_0')?.['email'])
      if (request.index === 1) {
        return {
          calls: Array.from({ length: 10 }, (_, i) => ({
            name: UPDATE.name,
            args: { id: `prod_${i}`, description: 'Ask [email-9]' },
          })),
        }
      }
      if (request.index === 2) {
        return {
          calls: Array.from({ length: 10 }, (_, i) => ({
            name: UPDATE.name,
            args: { id: `prod_${i}`, description: `Ask ${token}` },
          })),
        }
      }
      return { text: 'Done.' }
    })
    const frames: Frame[] = []

    await runAssistantTurn(
      {
        ai: model.ai,
        tools: store.tools,
        proposals: { get: async () => null },
        logger: silent,
        mask: [...DEFAULT_MASK],
      } as Deps,
      { caller, messages: [{ role: 'user', content: 'Update every apron.' }] },
      (frame) => void frames.push(frame as unknown as Frame),
    )

    expect(store.calls.filter((c) => c.name === UPDATE.name)).toEqual(
      Array.from({ length: 10 }, (_, i) => ({
        name: UPDATE.name,
        args: { id: `prod_${i}`, description: 'Ask ada@example.com' },
      })),
    )
    expect(frames.filter((f) => f.event === 'tool').map((f) => f.data['code'] ?? 'ran')).toEqual([
      'ran',
      ...Array.from({ length: 10 }, () => UNKNOWN_PLACEHOLDER),
      ...Array.from({ length: 10 }, () => 'ran'),
    ])
  })
})

// ─── AC-6 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('AC-6: the conversation the browser sends', () => {
  async function converse(
    messages: TurnMessages,
    script: (request: ScriptedRequest) => {
      text?: string
      calls?: Array<{ name: string; args: Record<string, unknown> }>
    },
    answer: (name: string, args: Record<string, unknown>) => ToolResult = () =>
      resultOf({ items: [], total: 0 }),
  ) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const tools: ToolSurface = {
      list: () => TOOLS,
      call: async (name, args) => {
        calls.push({ name, args: structuredClone(args) as Record<string, unknown> })
        return answer(name, args as Record<string, unknown>)
      },
    }
    const model = scriptedAi(script)
    await runAssistantTurn(
      {
        ai: model.ai,
        tools,
        proposals: { get: async () => null },
        logger: silent,
        mask: [...DEFAULT_MASK],
      } as Deps,
      { caller, messages },
      () => undefined,
    )
    return { calls, requests: model.requests }
  }

  it('AC-6: a typed email and phone reach the first request as [email-1] and [phone-1], and a search with [email-1] reaches the store as the typed email; no request holds either', async () => {
    const question = 'Find the customer ada@example.com, phone +44 7700 900123'

    const { calls, requests } = await converse([{ role: 'user', content: question }], (request) =>
      request.index === 0
        ? { calls: [{ name: SEARCH.name, args: { q: '[email-1]' } }] }
        : { text: 'None.' },
    )

    expect(requests[0]!.messages[0]!.content).toBe('Find the customer [email-1], phone [phone-1]')
    expect(calls).toEqual([{ name: SEARCH.name, args: { q: 'ada@example.com' } }])
    expect(
      requests.filter((r) => /ada@example\.com|\+44 7700 900123/.test(JSON.stringify(r.messages))),
    ).toEqual([])
  })

  it('AC-6: a question holding [email-1] reaches the model as [email 1]', async () => {
    const { requests } = await converse(
      [{ role: 'user', content: 'What does [email-1] mean in the export?' }],
      () => ({ text: 'A placeholder.' }),
    )

    expect(requests[0]!.messages[0]!.content).toBe('What does [email 1] mean in the export?')
  })

  const EARLIER = 'It goes to 12 Acacia Road, SW1A 1AA.'
  const spans = [
    {
      start: EARLIER.indexOf('12 Acacia Road'),
      end: EARLIER.indexOf('12 Acacia Road') + 14,
      kind: 'address',
    },
    { start: EARLIER.indexOf('SW1A 1AA'), end: EARLIER.indexOf('SW1A 1AA') + 8, kind: 'postcode' },
  ]

  it('AC-6: an earlier answer with revealed spans reaches the first request as [address-1], [postcode-1], and a search with [postcode-1] reaches the store as SW1A 1AA; no request holds either value', async () => {
    const { calls, requests } = await converse(
      [
        { role: 'user', content: 'Where does order NYM-1001 go?' },
        { role: 'assistant', content: EARLIER, revealed: spans },
        { role: 'user', content: 'Who else ships to that postcode?' },
      ] as TurnMessages,
      (request) =>
        request.index === 0
          ? { calls: [{ name: SEARCH.name, args: { q: '[postcode-1]' } }] }
          : { text: 'Nobody.' },
    )

    expect(requests[0]!.messages[1]!.content).toBe('It goes to [address-1], [postcode-1].')
    expect(calls).toEqual([{ name: SEARCH.name, args: { q: 'SW1A 1AA' } }])
    expect(
      requests.filter((r) => /12 Acacia Road|SW1A 1AA/.test(JSON.stringify(r.messages))),
    ).toEqual([])
  })

  it('AC-6: the same answer without spans reaches the first request in plain, and once a result holds 12 Acacia Road under addressLine1 every later request holds [address-1] in its place', async () => {
    const { requests } = await converse(
      [
        { role: 'user', content: 'Where does order NYM-1001 go?' },
        { role: 'assistant', content: EARLIER },
        { role: 'user', content: 'Whose address is that?' },
      ],
      (request) =>
        request.index === 0
          ? { calls: [{ name: GET.name, args: { id: 'cus_1' } }] }
          : request.index === 1
            ? { calls: [{ name: SEARCH.name, args: { q: 'Acacia' } }] }
            : { text: 'Ada’s.' },
      (name) =>
        name === GET.name
          ? resultOf({
              id: 'cus_1',
              addresses: [{ addressLine1: '12 Acacia Road', postalCode: 'E1 6AN' }],
            })
          : resultOf({ items: [], total: 0 }),
    )

    expect(requests.map((r) => r.messages[1]!.content)).toEqual([
      EARLIER,
      'It goes to [address-1], SW1A 1AA.',
      'It goes to [address-1], SW1A 1AA.',
    ])
    expect(
      requests.slice(1).filter((r) => JSON.stringify(r.messages).includes('12 Acacia Road')),
    ).toEqual([])
  })
})
