import { randomInt } from 'node:crypto'
import { inspect } from 'node:util'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { AiAdapter, Logger } from '@nymbalhq/types'
import { BOUND_MS, CASE_MS, settle, using, type Build } from './common.js'

// The ai slot's suite. The eval set (E1-E4) needs nothing but `build` and is phrased so that a real model and a
// rule-based stand-in both pass it: `nymbal test:contracts --package` runs it against a real key. The other cases need
// a stand-in behind the adapter (`AiContractOptions`): input refused before any call, `complete()` as `chat()`, and
// each provider failure mapped to one code, after one request, with no key in what is thrown or logged.
// An adapter whose `capabilities()` lists `tools` also runs eval E5 (one tool call and its result sent back) and the
// refused tool conversations; one that lists `stream` runs `chatStream()` against `chat()` and its failures. A
// chat-only adapter skips those cases, unless `requires` names the capability, when they fail.

/** A call the model asked for. */
interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

/** One turn of a conversation, as `chat()` takes it. */
type Turn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: readonly ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string; isError?: boolean }

interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

interface ChatOpts {
  system?: string
  maxTokens?: number
  tools?: readonly Tool[]
  signal?: AbortSignal
}

interface ChatReply {
  text: string
  stopReason: string
  usage: { inputTokens: number; outputTokens: number }
  model: string
  toolCalls?: ToolCall[]
}

type Chat = (messages: readonly Turn[], opts?: ChatOpts) => Promise<ChatReply>

type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; result: ChatReply }

type ChatStream = (messages: readonly Turn[], opts?: ChatOpts) => AsyncIterable<StreamEvent>

/** A capability a case is gated on. */
export type AiCapability = 'tools' | 'stream'

/** How a stand-in answers every request of a failing build. */
export type AiFailureMode =
  | `status:${number}`
  | 'html:502'
  | 'no-text'
  | 'not-json'
  | 'hang'
  | 'unreachable'
  | 'stream-break'
  | 'stream-error'
  | 'stream-stall'

/** A failing build: the adapter, and how many requests its provider has received. */
export interface AiFailingBuild {
  adapter: AiAdapter
  requests: () => number
  close: () => Promise<void>
  /** The text deltas the provider sent on its last stream; the stream failure cases need it. */
  sent?: () => string[]
  /** How many requests the client closed before the provider finished answering; the abort case needs it. */
  closed?: () => number
}

export interface AiContractOptions {
  /**
   * How many requests the provider behind `build` has received. Given, the suite adds the cases that count them:
   * refused input makes none, and `complete()` makes one, as `chat()` does.
   */
  requests?: () => number
  /**
   * An adapter built with `key` as its configured key and `logger` as its logger, on a provider that answers every
   * request as `mode`: `status:<n>` answers n with the provider's JSON error, its message echoing the key raw, as
   * base64 and as base64url, and longer than 300 characters; `html:502` answers 502 with an HTML page; `no-text`
   * answers 200 with no text; `not-json` answers 200 with a body that is not JSON; `hang` accepts the request and
   * never answers, the adapter built with `timeoutMs: 300`; `unreachable` refuses the connection. Every mode but
   * `unreachable` echoes the key in its body and in a response header; the error messages of `status:<n>` and
   * `stream-error` echo the last user turn's text too. On a stream request only (anything else is answered as a
   * model): `stream-break` sends the first two text deltas and destroys the connection; `stream-error` sends one
   * delta and then the provider's mid-stream error; `stream-stall` sends one delta and then nothing, the adapter built
   * with `timeoutMs: 300`. Given, the suite adds the failure cases.
   */
  failing?: (mode: AiFailureMode, key: string, logger: Logger) => Promise<AiFailingBuild>
  /**
   * The capabilities the adapter must list: a case gated on one fails when `capabilities()` lacks it, where it would
   * be skipped. A provider package that ships tools and streaming names both, so dropping one cannot pass as a skip.
   */
  requires?: readonly AiCapability[]
}

const HANG_TIMEOUT_MS = 300
/** The hanging build's `timeoutMs`, and the room a rejection has after it. */
const HANG_BOUND_MS = HANG_TIMEOUT_MS + 2000

const STATUS_CODES: ReadonlyArray<readonly [AiFailureMode, string]> = [
  ['status:400', 'adapter.invalid_request'],
  ['status:401', 'adapter.auth_failed'],
  ['status:403', 'adapter.auth_failed'],
  ['status:429', 'adapter.rate_limited'],
  ['status:500', 'adapter.unavailable'],
  ['status:529', 'adapter.unavailable'],
  ['html:502', 'adapter.unavailable'],
  ['no-text', 'adapter.unexpected_response'],
  ['not-json', 'adapter.unexpected_response'],
]

const ALL_MODES: readonly AiFailureMode[] = [
  ...STATUS_CODES.map(([mode]) => mode),
  'hang',
  'unreachable',
]

function chatOf(adapter: AiAdapter): Chat {
  const chat = (adapter as unknown as { chat?: Chat }).chat
  expect(typeof chat, 'the adapter has no chat()').toBe('function')
  return chat!.bind(adapter)
}

function chatStreamOf(adapter: AiAdapter): ChatStream {
  const stream = (adapter as unknown as { chatStream?: ChatStream }).chatStream
  expect(typeof stream, 'the adapter lists stream but has no chatStream()').toBe('function')
  return stream!.bind(adapter)
}

/** Whether the adapter lists `capability`; failing the case when it does not and `requires` names it. */
function lists(adapter: AiAdapter, capability: AiCapability, requires: readonly AiCapability[]) {
  const listed = (adapter.capabilities() as readonly string[]).includes(capability)
  if (!listed && requires.includes(capability)) {
    expect.fail(
      `capabilities() is ${JSON.stringify(adapter.capabilities())}, without ${capability}, which this adapter must list`,
    )
  }
  return listed
}

/** Every event a stream yields until it ends, throws or `ms` passes, and how it settled. */
async function drain(
  stream: () => AsyncIterable<StreamEvent>,
  ms: number,
  onEvent: (event: StreamEvent) => void = () => undefined,
) {
  const events: StreamEvent[] = []
  const outcome = await settle(async () => {
    for await (const event of stream()) {
      events.push(event)
      onEvent(event)
    }
  }, ms)
  return { events, outcome }
}

const textsOf = (events: readonly StreamEvent[]): string[] =>
  events.flatMap((e) => (e.type === 'text' ? [e.delta] : []))
const callsOf = (events: readonly StreamEvent[]): ToolCall[] =>
  events.flatMap((e) => (e.type === 'tool_call' ? [e.call] : []))
const donesOf = (events: readonly StreamEvent[]): ChatReply[] =>
  events.flatMap((e) => (e.type === 'done' ? [e.result] : []))

function completeOf(adapter: AiAdapter) {
  return (prompt: string, opts: { maxTokens: number }) => adapter.complete(prompt, opts)
}

interface Refusal {
  /** What was thrown, as it was. */
  thrown: unknown
  name: unknown
  code: unknown
  message: unknown
  context: unknown
  hasCause: boolean
  ms: number
}

/** How `call` rejected within `ms`; fails the case when it resolved or was still pending. */
async function rejection(call: () => Promise<unknown>, ms = BOUND_MS): Promise<Refusal> {
  const outcome = await settle(call, ms)
  expect(
    outcome.state,
    outcome.state === 'hung' ? `still pending after ${ms} ms` : 'it resolved',
  ).toBe('rejected')
  const thrown = outcome.state === 'rejected' ? outcome.error : undefined
  const fields = (typeof thrown === 'object' && thrown !== null ? thrown : {}) as Record<
    string,
    unknown
  >
  return {
    thrown,
    name: fields['name'],
    code: fields['code'],
    message: fields['message'],
    context: fields['context'],
    hasCause: 'cause' in fields,
    ms: outcome.ms,
  }
}

/** Every record a logger receives, as [level, ...arguments], its children's included. */
function recordingLogger(records: unknown[][]): Logger {
  const at =
    (level: string) =>
    (...args: unknown[]): void => {
      records.push([level, ...args])
    }
  const logger: Logger = {
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: (bindings) => {
      records.push(['child', bindings])
      return logger
    },
  }
  return logger
}

const deep = (value: unknown): string => inspect(value, { depth: Infinity, showHidden: true })

/** The key as it could leak: raw, base64 (unpadded, so a padded copy matches too) and base64url. */
function formsOf(key: string): string[] {
  const bytes = Buffer.from(key, 'utf8')
  return [key, bytes.toString('base64').replace(/=+$/, ''), bytes.toString('base64url')]
}

/** At least 16 URL-safe characters, with enough distinct ones that a match is the key and not a run. */
const keyArb = fc
  .string({
    unit: fc.constantFrom(
      ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.split(''),
    ),
    minLength: 16,
    maxLength: 48,
  })
  .filter((s) => new Set(s).size >= 8)

/** A conversation `chat()` must refuse before any call. */
const refusedInput = fc.oneof(
  fc.constant({ messages: [] as Turn[], opts: {} }),
  fc.constant({
    messages: [
      { role: 'assistant', content: 'Hello.' },
      { role: 'user', content: 'Say hello.' },
    ] as Turn[],
    opts: {},
  }),
  fc.integer({ min: 0, max: 2 }).map((empty) => ({
    messages: (
      [
        { role: 'user', content: 'The code word is lantern.' },
        { role: 'assistant', content: 'Noted.' },
        { role: 'user', content: 'Say hello.' },
      ] as Turn[]
    ).map((turn, i) => (i === empty ? { ...turn, content: '' } : turn)),
    opts: {},
  })),
  fc
    .oneof(
      fc.integer({ min: -1_000_000, max: 0 }),
      fc.double({ min: 0.001, max: 4096, noNaN: true }).filter((n) => !Number.isInteger(n)),
      fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY),
    )
    .map((maxTokens) => ({
      messages: [{ role: 'user', content: 'Say hello.' }] as Turn[],
      opts: { maxTokens },
    })),
)

const CODE_WORDS = ['lantern', 'juniper', 'saffron', 'harbour', 'quartz', 'meadow']

/** Eval E5's tool: its schema admits exactly `{ sku: <string> }`. */
const LOOKUP_PRICE: Tool = {
  name: 'lookup_price',
  description: 'The price of one product, by its SKU.',
  inputSchema: {
    type: 'object',
    properties: { sku: { type: 'string', description: 'The product SKU, e.g. B-4.' } },
    required: ['sku'],
    additionalProperties: false,
  },
}
const E5_ASK = 'What does SKU A-17 cost? Use the lookup_price tool.'
const E5_RESULT = 'A-17 costs 42.50 EUR.'

const toolNamed = (name: string): Tool => ({
  name,
  description: 'Reads one thing from the store.',
  inputSchema: { type: 'object', properties: {} },
})

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/
const callIdArb = fc.string({
  unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_'.split('')),
  minLength: 4,
  maxLength: 24,
})
const twoIds = fc.tuple(callIdArb, callIdArb).filter(([a, b]) => a !== b)
const askFor = (id: string): ToolCall => ({ id, name: 'lookup_price', args: { sku: 'A-17' } })
const user = (content: string): Turn => ({ role: 'user', content })
const assistant = (content: string, toolCalls?: readonly ToolCall[]): Turn =>
  toolCalls === undefined
    ? { role: 'assistant', content }
    : { role: 'assistant', content, toolCalls }
const toolTurn = (toolCallId: string, content: string): Turn => ({
  role: 'tool',
  toolCallId,
  content,
})

/** A tool conversation `chat()` must refuse before any call, with what makes it so. */
const refusedToolInput: fc.Arbitrary<{ why: string; messages: Turn[]; opts: ChatOpts }> = fc.oneof(
  twoIds.map(([a, b]) => ({
    why: 'a tool turn answers no call of the assistant turn before it',
    messages: [user(E5_ASK), assistant('', [askFor(a)]), toolTurn(b, E5_RESULT)],
    opts: { tools: [LOOKUP_PRICE] },
  })),
  twoIds.map(([a, b]) => ({
    why: 'a tool turn answers a call of an earlier assistant turn, not the nearest',
    messages: [
      user(E5_ASK),
      assistant('', [askFor(a)]),
      toolTurn(a, E5_RESULT),
      user('And SKU B-2? Use the lookup_price tool.'),
      assistant('', [askFor(b)]),
      toolTurn(a, E5_RESULT),
    ],
    opts: { tools: [LOOKUP_PRICE] },
  })),
  callIdArb.map((a) => ({
    why: 'a tool turn follows the user turn, with no assistant turn before it',
    messages: [user(E5_ASK), toolTurn(a, E5_RESULT)],
    opts: { tools: [LOOKUP_PRICE] },
  })),
  twoIds.map(([a, b]) => ({
    why: 'a call is left unanswered when the next user turn starts',
    messages: [
      user(E5_ASK),
      assistant('', [askFor(a), askFor(b)]),
      toolTurn(a, E5_RESULT),
      user('Go on.'),
    ],
    opts: { tools: [LOOKUP_PRICE] },
  })),
  callIdArb.map((a) => ({
    why: 'a call is left unanswered when the next assistant turn starts',
    messages: [user(E5_ASK), assistant('', [askFor(a)]), assistant('It costs 42.50 EUR.')],
    opts: { tools: [LOOKUP_PRICE] },
  })),
  fc.constantFrom<readonly ToolCall[] | undefined>(undefined, []).map((toolCalls) => ({
    why: 'an assistant turn has empty content and no calls',
    messages: [user(E5_ASK), assistant('', toolCalls), user('Go on.')],
    opts: { tools: [LOOKUP_PRICE] },
  })),
  callIdArb.map((a) => ({
    why: 'a tool turn has empty content',
    messages: [user(E5_ASK), assistant('', [askFor(a)]), toolTurn(a, '')],
    opts: { tools: [LOOKUP_PRICE] },
  })),
  fc.stringMatching(TOOL_NAME).map((name) => ({
    why: `two tools are named ${name}`,
    messages: [user('Say hello.')],
    opts: { tools: [toolNamed(name), LOOKUP_PRICE, toolNamed(name)] },
  })),
  fc
    .oneof(
      fc.constant(''),
      fc.constant('x'.repeat(65)),
      fc.stringMatching(/^[A-Za-z0-9_-]{65,90}$/),
      fc.string({ minLength: 1, maxLength: 20 }).filter((name) => !TOOL_NAME.test(name)),
    )
    .map((name) => ({
      why: `the tool name ${JSON.stringify(name)} is outside ^[A-Za-z0-9_-]{1,64}$`,
      messages: [user('Say hello.')],
      opts: { tools: [LOOKUP_PRICE, toolNamed(name)] },
    })),
)

/** The conversations the stream cases replay through both `chatStream()` and `chat()`: E1-E3, a cut count, E5's first turn. */
const STREAMED: ReadonlyArray<{
  label: string
  tools: boolean
  messages: () => Turn[]
  opts: ChatOpts
}> = [
  {
    label: 'E1',
    tools: false,
    messages: () => [user('Reply with exactly the word PONG.')],
    opts: {},
  },
  {
    label: 'E2',
    tools: false,
    messages: () => {
      const word = `${CODE_WORDS[randomInt(CODE_WORDS.length)]}${randomInt(100, 1000)}`
      return [
        user(`The code word is ${word}.`),
        assistant('Noted.'),
        user('What is the code word? Reply with the word only.'),
      ]
    },
    opts: {},
  },
  {
    label: 'E3',
    tools: false,
    messages: () => [user('Say hello.')],
    opts: { system: 'Answer only in upper case.' },
  },
  {
    label: 'a count cut at maxTokens 5',
    tools: false,
    messages: () => [user('Count from 1 to 12.')],
    opts: { maxTokens: 5 },
  },
  {
    label: 'E5 first turn',
    tools: true,
    messages: () => [user(E5_ASK)],
    opts: { tools: [LOOKUP_PRICE] },
  },
]

const STREAM_STATUS: ReadonlyArray<readonly [AiFailureMode, string]> = [
  ['status:401', 'adapter.auth_failed'],
  ['status:429', 'adapter.rate_limited'],
  ['status:529', 'adapter.unavailable'],
]

/** The failures a stream can meet, beyond those of a plain request. */
const STREAM_MODES: readonly AiFailureMode[] = ['stream-break', 'stream-error']

const words = (text: string): string[] => text.split(/\s+/).filter((w) => w !== '')

/** What a run wrote to stdout, stderr or the console, with DEBUG=true set for it. */
async function underDebug<T>(run: () => Promise<T>): Promise<{ value: T; written: string[] }> {
  const written: string[] = []
  const out = process.stdout.write
  const err = process.stderr.write
  // The console as a record: its methods are replaced for the run, not called.
  const terminal = console as unknown as Record<string, (...args: unknown[]) => void>
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir'] as const
  const saved = methods.map((method) => terminal[method])
  const debug = process.env['DEBUG']
  const capture = ((chunk: unknown) => {
    written.push(
      typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'),
    )
    return true
  }) as typeof process.stdout.write
  process.stdout.write = capture
  process.stderr.write = capture
  for (const method of methods) {
    terminal[method] = (...args: unknown[]) => {
      written.push(args.map((arg) => (typeof arg === 'string' ? arg : deep(arg))).join(' '))
    }
  }
  process.env['DEBUG'] = 'true'
  try {
    return { value: await run(), written }
  } finally {
    process.stdout.write = out
    process.stderr.write = err
    methods.forEach((method, i) => {
      terminal[method] = saved[i]!
    })
    if (debug === undefined) delete process.env['DEBUG']
    else process.env['DEBUG'] = debug
  }
}

/** Waits until `ready()` or `ms` has passed. */
async function until(ready: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (!ready() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
}

/**
 * Certifies an ai adapter's `chat()`: the eval set always, and with `options` the cases a stand-in makes possible.
 * `build` makes a fresh adapter whose provider answers as a model.
 */
export function runAiContract(
  name: string,
  build: Build<AiAdapter>,
  options: AiContractOptions = {},
): void {
  describe(`ai contract: ${name}`, () => {
    // Kills: a raw stop reason passed through, usage left unmapped, or the reported model dropped.
    it(
      'eval E1: "Reply with exactly the word PONG." answers PONG, stopReason end, usage on both sides and a model',
      () =>
        using(build, async (adapter) => {
          const result = await chatOf(adapter)([
            { role: 'user', content: 'Reply with exactly the word PONG.' },
          ])
          expect(result.text).toContain('PONG')
          expect(result.stopReason).toBe('end')
          expect(result.usage.inputTokens).toBeGreaterThan(0)
          expect(result.usage.outputTokens).toBeGreaterThan(0)
          expect(result.model.trim().length, 'the model is empty').toBeGreaterThan(0)
        }),
      CASE_MS,
    )

    // Kills: only the last turn sent, the turns reordered, or the assistant's turn sent under another role.
    it(
      'eval E2: a three-turn conversation recalls the code word from the first turn',
      () =>
        using(build, async (adapter) => {
          const word = `${CODE_WORDS[randomInt(CODE_WORDS.length)]}${randomInt(100, 1000)}`
          const result = await chatOf(adapter)([
            { role: 'user', content: `The code word is ${word}.` },
            { role: 'assistant', content: 'Noted.' },
            { role: 'user', content: 'What is the code word? Reply with the word only.' },
          ])
          expect(result.text.toLowerCase()).toContain(word)
        }),
      CASE_MS,
    )

    // Kills: the system prompt dropped, or sent as a user turn the model may ignore.
    it(
      'eval E3: system "Answer only in upper case." makes the answer its own upper case',
      () =>
        using(build, async (adapter) => {
          const result = await chatOf(adapter)([{ role: 'user', content: 'Say hello.' }], {
            system: 'Answer only in upper case.',
          })
          expect(result.text, 'the answer has no letter').toMatch(/[A-Z]/)
          expect(result.text).toBe(result.text.toUpperCase())
        }),
      CASE_MS,
    )

    // Kills: maxTokens ignored (the default sent), or the length stop reason passed through raw.
    it(
      'eval E4: maxTokens 1 on "Count from 1 to 100." stops at max_tokens with at most one output token',
      () =>
        using(build, async (adapter) => {
          const result = await chatOf(adapter)(
            [{ role: 'user', content: 'Count from 1 to 100.' }],
            { maxTokens: 1 },
          )
          expect(result.stopReason).toBe('max_tokens')
          expect(result.usage.outputTokens).toBeLessThanOrEqual(1)
        }),
      CASE_MS,
    )

    const requires = options.requires ?? []

    // Kills: tools not sent, a call's id not carried back, the tool turn sent under the wrong role or block, or the
    // call's arguments left as the wire's JSON string.
    it(
      'AC-1: eval E5: with the lookup_price tool, "What does SKU A-17 cost?" asks for one call { sku: "A-17" } with an id and stops at tool_use; sending that call and its result back answers with the result\'s price',
      (ctx) =>
        using(build, async (adapter) => {
          if (!lists(adapter, 'tools', requires)) return ctx.skip()
          const chat = chatOf(adapter)
          const ask = user(E5_ASK)
          const first = await chat([ask], { tools: [LOOKUP_PRICE] })
          expect(first.stopReason).toBe('tool_use')
          const calls = first.toolCalls ?? []
          expect(calls.map((c) => c.name)).toEqual(['lookup_price'])
          const call = calls[0]!
          expect(call.args).toEqual({ sku: 'A-17' })
          expect(call.id.trim(), 'the call has no id').not.toBe('')

          const second = await chat(
            [ask, assistant(first.text, first.toolCalls), toolTurn(call.id, E5_RESULT)],
            { tools: [LOOKUP_PRICE] },
          )
          expect(second.text).toContain('42.50')
          expect(second.toolCalls ?? []).toEqual([])
        }),
      CASE_MS,
    )

    const requests = options.requests
    if (requests !== undefined) {
      // Kills: a malformed tool conversation sent on to the provider (and refused there as a 400), or the two providers
      // validating differently.
      it(
        'AC-3: a tool turn answering no call of the nearest assistant turn, an unanswered call, an empty assistant turn with no calls, an empty tool turn, two tools of one name or a tool name outside ^[A-Za-z0-9_-]{1,64}$ rejects adapter.invalid_request with no request made',
        (ctx) =>
          using(build, async (adapter) => {
            if (!lists(adapter, 'tools', requires)) return ctx.skip()
            const chat = chatOf(adapter)
            await fc.assert(
              fc.asyncProperty(refusedToolInput, async ({ why, messages, opts }) => {
                const before = requests()
                const error = await rejection(() => chat(messages, opts))
                expect(error.code, `${why}: ${String(error.message)}`).toBe(
                  'adapter.invalid_request',
                )
                expect(error.context).toEqual({ provider: adapter.providerName })
                expect(requests() - before, `${why}: a request was made`).toBe(0)
              }),
              { numRuns: 60 },
            )
          }),
        CASE_MS,
      )

      // Kills: a stream that buffers the answer into one delta, drops a delta, yields a call before its arguments are
      // complete, or ends (text, stop reason, calls) other than chat() does.
      for (const { label, tools, messages, opts } of STREAMED) {
        it(
          `AC-5: chatStream() on ${label}: one done, last, whose text the text deltas concatenate to (two or more for a multi-word answer) and whose calls the tool_call events are, equal in text, stopReason and calls to chat() on the same conversation, one request each`,
          (ctx) =>
            using(build, async (adapter) => {
              if (!lists(adapter, 'stream', requires)) return ctx.skip()
              if (tools && !lists(adapter, 'tools', requires)) return ctx.skip()
              const conversation = messages()
              const before = requests()
              const { events, outcome } = await drain(
                () => chatStreamOf(adapter)(conversation, opts),
                BOUND_MS,
              )
              expect(outcome.state, outcome.state === 'rejected' ? deep(outcome.error) : '').toBe(
                'resolved',
              )
              const dones = donesOf(events)
              expect(dones, 'not exactly one done event').toHaveLength(1)
              expect(events.at(-1)?.type).toBe('done')
              const done = dones[0]!
              const texts = textsOf(events)
              expect(texts.join('')).toBe(done.text)
              expect(texts.length).toBeGreaterThanOrEqual(Math.min(words(done.text).length, 2))
              expect(callsOf(events)).toEqual(done.toolCalls)

              const viaChat = await chatOf(adapter)(conversation, opts)
              expect({
                text: done.text,
                stopReason: done.stopReason,
                toolCalls: done.toolCalls,
              }).toEqual({
                text: viaChat.text,
                stopReason: viaChat.stopReason,
                toolCalls: viaChat.toolCalls,
              })
              expect(requests() - before).toBe(2)
            }),
          CASE_MS,
        )
      }

      // Kills: bad input sent on to the provider (and refused there as a 400), or validated on one provider only.
      it(
        'input: empty messages, a first turn that is not the user, an empty content or a maxTokens that is not a positive integer rejects adapter.invalid_request with no request made',
        () =>
          using(build, async (adapter) => {
            const chat = chatOf(adapter)
            await fc.assert(
              fc.asyncProperty(refusedInput, async ({ messages, opts }) => {
                const before = requests()
                const error = await rejection(() => chat(messages, opts))
                expect(error.code, String(error.message)).toBe('adapter.invalid_request')
                expect(error.context).toEqual({ provider: adapter.providerName })
                expect(requests()).toBe(before)
              }),
              { numRuns: 30 },
            )
          }),
        CASE_MS,
      )

      // Kills: complete() on a request path of its own that drifts from chat(), or its maxTokens dropped.
      it(
        'complete(prompt, { maxTokens }) answers what chat() answers as text for the same single user turn, in one request',
        () =>
          using(build, async (adapter) => {
            const chat = chatOf(adapter)
            const complete = completeOf(adapter)
            for (const [prompt, maxTokens] of [
              ['Reply with exactly the word PONG.', 16],
              ['Count from 1 to 100.', 1],
            ] as const) {
              const viaChat = await chat([{ role: 'user', content: prompt }], { maxTokens })
              const before = requests()
              const viaComplete = await complete(prompt, { maxTokens })
              expect(requests() - before, 'complete() made other than one request').toBe(1)
              expect(viaComplete, `${prompt} with maxTokens ${maxTokens}`).toBe(viaChat.text)
            }
          }),
        CASE_MS,
      )
    }

    const failing = options.failing
    if (failing !== undefined) {
      describe('provider failures', () => {
        /** The refusal one chat() on a fresh failing build gives, with the requests it made and the log records. */
        async function failOnce(mode: AiFailureMode, key: string, content: string, ms: number) {
          const records: unknown[][] = []
          const built = await failing!(mode, key, recordingLogger(records))
          try {
            const chat = chatOf(built.adapter)
            const error = await rejection(() => chat([{ role: 'user', content }]), ms)
            return {
              error,
              thrown: error.thrown,
              records,
              requests: built.requests(),
              provider: built.adapter.providerName,
            }
          } finally {
            await built.close()
          }
        }

        for (const [mode, code] of STATUS_CODES) {
          // Kills: the SDK's error escaping unwrapped, a retry (three requests), or one code for every failure.
          it(
            `${mode} rejects ${code} after exactly one request, its context only provider and status`,
            async () => {
              const key = `sk-contract-${randomInt(1e9, 1e10)}-key`
              const {
                error,
                requests: made,
                provider,
              } = await failOnce(mode, key, 'Say hello.', BOUND_MS)
              expect(error.code, String(error.message)).toBe(code)
              expect(error.name).toBe('AdapterError')
              expect(made).toBe(1)
              expect(error.hasCause, 'the error keeps a cause').toBe(false)
              const context = (error.context ?? {}) as Record<string, unknown>
              expect(
                Object.keys(context).filter((k) => k !== 'provider' && k !== 'status'),
              ).toEqual([])
              expect(context['provider']).toBe(provider)
              const message = String(error.message)
              if (mode.startsWith('status:')) {
                const status = Number(mode.slice('status:'.length))
                expect(context['status']).toBe(status)
                // The provider's own message is dropped: it may echo the key or the conversation.
                expect(message).toBe(`${provider} answered ${status}`)
              } else if (mode === 'html:502') {
                expect(context['status']).toBe(502)
                expect(message).toBe(`${provider} answered 502`)
              } else {
                expect([undefined, 200]).toContain(context['status'])
              }
            },
            CASE_MS,
          )
        }

        // Kills: the SDK's 600 s timeout and its retries, or a connection error passed through as it is.
        it(
          `a refused connection rejects adapter.unavailable within ${BOUND_MS} ms: "<provider> could not be reached"`,
          async () => {
            const { error, provider } = await failOnce(
              'unreachable',
              'sk-contract-unreachable-key',
              'Say hello.',
              BOUND_MS,
            )
            expect(error.code, String(error.message)).toBe('adapter.unavailable')
            expect(error.ms).toBeLessThanOrEqual(BOUND_MS)
            expect(error.hasCause, 'the error keeps a cause').toBe(false)
            expect(error.context).toEqual({ provider })
            expect(error.message).toBe(`${provider} could not be reached`)
          },
          CASE_MS,
        )

        // Kills: a fetch with no abort, or a timeout that fires before timeoutMs or retries after it.
        it(
          `a provider that never answers rejects adapter.timeout after timeoutMs ${HANG_TIMEOUT_MS} and within ${HANG_BOUND_MS} ms, after one request`,
          async () => {
            const {
              error,
              requests: made,
              provider,
            } = await failOnce('hang', 'sk-contract-hanging-key', 'Say hello.', HANG_BOUND_MS)
            expect(error.code, String(error.message)).toBe('adapter.timeout')
            expect(error.ms).toBeGreaterThanOrEqual(HANG_TIMEOUT_MS - 10)
            expect(error.ms).toBeLessThanOrEqual(HANG_BOUND_MS)
            expect(made).toBe(1)
            expect(error.hasCause, 'the error keeps a cause').toBe(false)
            expect(error.context).toEqual({ provider })
            expect(error.message).toBe(`${provider} gave no answer within ${HANG_TIMEOUT_MS} ms`)
          },
          CASE_MS,
        )

        /** One chatStream() on a fresh failing build: the events it yielded, how it ended, and what the provider saw. */
        async function streamOnce(
          mode: AiFailureMode,
          content: string,
          ms: number,
          opts: ChatOpts = {},
          onEvent?: (event: StreamEvent) => void,
        ) {
          const built = await failing!(
            mode,
            `sk-contract-${randomInt(1e9, 1e10)}-key`,
            recordingLogger([]),
          )
          try {
            if (!lists(built.adapter, 'stream', requires)) return undefined
            const stream = chatStreamOf(built.adapter)
            const started = Date.now()
            const { events, outcome } = await drain(
              () => stream([user(content)], opts),
              ms,
              onEvent,
            )
            expect(
              outcome.state,
              outcome.state === 'hung' ? `still pending after ${ms} ms` : 'it resolved',
            ).toBe('rejected')
            const thrown = (outcome.state === 'rejected' ? outcome.error : {}) as Record<
              string,
              unknown
            >
            return {
              events,
              code: thrown['code'],
              name: thrown['name'],
              context: thrown['context'],
              hasCause: 'cause' in thrown,
              settledAt: started + outcome.ms,
              requests: built.requests(),
              sent: built.sent?.() ?? [],
              closed: built.closed,
              provider: built.adapter.providerName,
            }
          } finally {
            await built.close()
          }
        }

        // Kills: a failed stream status passed on as an event or an end, or one code for every status.
        for (const [mode, code] of STREAM_STATUS) {
          it(
            `AC-6: chatStream() on ${mode} rejects ${code} before any event, after one request, its context only provider and status`,
            async (ctx) => {
              const failed = await streamOnce(mode, 'Say hello.', BOUND_MS)
              if (failed === undefined) return ctx.skip()
              expect(failed.code).toBe(code)
              expect(failed.name).toBe('AdapterError')
              expect(failed.events).toEqual([])
              expect(failed.requests).toBe(1)
              expect(failed.hasCause, 'the error keeps a cause').toBe(false)
              expect(failed.context).toEqual({
                provider: failed.provider,
                status: Number(mode.slice('status:'.length)),
              })
            },
            CASE_MS,
          )
        }

        // Kills: a stream broken mid-answer ended as if complete (the truncated answer passed as done).
        it(
          'AC-6: chatStream() on a connection broken after two deltas yields those two deltas, no done, and rejects adapter.unavailable after one request',
          async (ctx) => {
            const failed = await streamOnce('stream-break', 'Count from 1 to 10.', BOUND_MS)
            if (failed === undefined) return ctx.skip()
            expect(failed.code).toBe('adapter.unavailable')
            expect(textsOf(failed.events)).toEqual(failed.sent)
            expect(failed.sent).toHaveLength(2)
            expect(donesOf(failed.events)).toEqual([])
            expect(failed.requests).toBe(1)
          },
          CASE_MS,
        )

        // Kills: the provider's mid-stream error event ignored, so the stream ends as if complete or hangs.
        it(
          "AC-6: chatStream() on the provider's mid-stream error event yields no done and rejects adapter.unavailable after one request",
          async (ctx) => {
            const failed = await streamOnce('stream-error', 'Count from 1 to 10.', BOUND_MS)
            if (failed === undefined) return ctx.skip()
            expect(failed.code).toBe('adapter.unavailable')
            expect(donesOf(failed.events)).toEqual([])
            expect(failed.hasCause, 'the error keeps a cause').toBe(false)
            expect(failed.requests).toBe(1)
          },
          CASE_MS,
        )

        // Kills: a stream bounded only until the response's head, or not bounded at all.
        for (const mode of ['hang', 'stream-stall'] as const) {
          it(
            `AC-6: chatStream() on a provider that ${mode === 'hang' ? 'never answers' : 'stops after one delta'} rejects adapter.timeout after timeoutMs ${HANG_TIMEOUT_MS} and within ${HANG_BOUND_MS} ms, after one request`,
            async (ctx) => {
              const started = Date.now()
              const failed = await streamOnce(mode, 'Count from 1 to 10.', HANG_BOUND_MS)
              if (failed === undefined) return ctx.skip()
              expect(failed.code).toBe('adapter.timeout')
              expect(failed.settledAt - started).toBeGreaterThanOrEqual(HANG_TIMEOUT_MS - 10)
              expect(failed.settledAt - started).toBeLessThanOrEqual(HANG_BOUND_MS)
              expect(textsOf(failed.events)).toEqual(failed.sent)
              expect(failed.requests).toBe(1)
            },
            CASE_MS,
          )
        }

        // Kills: an abort that leaves the provider's request running (the key spent for a caller who has gone), or one
        // that is reported as a timeout or a provider failure.
        it(
          'AC-6: aborting the signal after the first delta rejects adapter.cancelled within 1000 ms and the provider sees its connection closed',
          async (ctx) => {
            const controller = new AbortController()
            let abortedAt = 0
            const failed = await streamOnce(
              'stream-stall',
              'Count from 1 to 10.',
              BOUND_MS,
              { signal: controller.signal },
              (event) => {
                if (event.type === 'text' && abortedAt === 0) {
                  abortedAt = Date.now()
                  controller.abort()
                }
              },
            )
            if (failed === undefined) return ctx.skip()
            expect(failed.code).toBe('adapter.cancelled')
            expect(abortedAt, 'no text delta arrived before the stream ended').not.toBe(0)
            expect(failed.settledAt - abortedAt).toBeLessThanOrEqual(1000)
            expect(typeof failed.closed, 'the failing build reports no closed connections').toBe(
              'function',
            )
            await until(() => failed.closed!() === 1, 1000)
            expect(failed.closed!()).toBe(1)
            expect(failed.requests).toBe(1)
          },
          CASE_MS,
        )

        // Kills: the Anthropic SDK in the request path (under DEBUG=true it prints x-api-key and the request body), the
        // provider's message passed on with the conversation it echoed, or a stream error keeping the response or its
        // headers.
        it('AC-7: property: with DEBUG=true, over chat() and chatStream(), every failure (the stream ones included) and a random configured key, neither the key (raw, base64, base64url) nor the user message appears in stdout, stderr or the console, in the error inspected or serialised, or in any log record', async () => {
          const probe = await failing!('status:500', 'sk-contract-probe-key', recordingLogger([]))
          // Not `lists`: a missing stream fails the stream cases, and here the chat() half still runs.
          const streams = (probe.adapter.capabilities() as readonly string[]).includes('stream')
          await probe.close()
          const runs: Array<readonly ['chat' | 'chatStream', AiFailureMode]> = [
            ...ALL_MODES.map((mode) => ['chat', mode] as const),
            ...(streams
              ? [...ALL_MODES, ...STREAM_MODES].map((mode) => ['chatStream', mode] as const)
              : []),
          ]
          await fc.assert(
            fc.asyncProperty(
              fc.constantFrom(...runs),
              keyArb,
              fc.uuid(),
              async ([via, mode], key, marker) => {
                const content = `Count from 1 to 10. Private note ${marker}.`
                const records: unknown[][] = []
                const built = await failing!(mode, key, recordingLogger(records))
                let thrown: unknown
                let written: string[] = []
                try {
                  /** What the call rejected with, or undefined when it did not. */
                  const failure = async (): Promise<unknown> => {
                    const { outcome } =
                      via === 'chat'
                        ? {
                            outcome: await settle(
                              () => chatOf(built.adapter)([user(content)]),
                              HANG_BOUND_MS + BOUND_MS,
                            ),
                          }
                        : await drain(
                            () => chatStreamOf(built.adapter)([user(content)]),
                            HANG_BOUND_MS + BOUND_MS,
                          )
                    return outcome.state === 'rejected' ? outcome.error : undefined
                  }
                  const ran = await underDebug(failure)
                  thrown = ran.value
                  written = ran.written
                } finally {
                  await built.close()
                }
                expect(thrown, `${via} on ${mode} did not reject`).toBeInstanceOf(Error)
                const outputs = [
                  deep(thrown),
                  JSON.stringify(thrown) ?? '',
                  ...records.map((record) => record.map(deep).join(' ')),
                  ...written,
                ]
                const forms = formsOf(key)
                expect(
                  outputs.flatMap((text, at) =>
                    forms.filter((form) => text.includes(form)).map((form) => `${at}: ${form}`),
                  ),
                  `the key leaked from ${via} on ${mode}`,
                ).toEqual([])
                expect(
                  outputs.filter((text) => text.includes(marker)).map((text) => text.slice(0, 200)),
                  `the user message leaked from ${via} on ${mode}`,
                ).toEqual([])
              },
            ),
            {
              numRuns: runs.length + 12,
              // Every run kind on every mode once, so a leak in one branch only cannot pass by chance.
              examples: runs.map(
                (run): [readonly ['chat' | 'chatStream', AiFailureMode], string, string] => [
                  run,
                  'sk-Ex4mple_Key-012345678',
                  '6f1c2a3b-4d5e-4f60-8a71-b2c3d4e5f607',
                ],
              ),
            },
          )
        }, 180_000)

        // Kills: the SDK error or the Response kept as cause or context (a Headers instance passes every scrubber), the
        // provider's message passed on with the key it echoed, or the request, its headers or its messages logged.
        it('property: over every failure and a random configured key, neither the key nor its base64 or base64url is in the error inspected or serialised, or in any log record, and no log record holds the message text', async () => {
          await fc.assert(
            fc.asyncProperty(
              fc.constantFrom(...ALL_MODES),
              keyArb,
              fc.uuid(),
              async (mode, key, marker) => {
                const content = `Say hello. Private note ${marker}.`
                const { thrown, records } = await failOnce(
                  mode,
                  key,
                  content,
                  HANG_BOUND_MS + BOUND_MS,
                )
                const outputs = [
                  deep(thrown),
                  JSON.stringify(thrown) ?? '',
                  ...records.map((record) => record.map(deep).join(' ')),
                ]
                const forms = formsOf(key)
                expect(
                  outputs.flatMap((text, at) =>
                    forms.filter((form) => text.includes(form)).map((form) => `${at}: ${form}`),
                  ),
                  `the key leaked under ${mode}`,
                ).toEqual([])
                expect(
                  records.filter((record) => record.map(deep).join(' ').includes(marker)),
                  `a log record holds the message text under ${mode}`,
                ).toEqual([])
              },
            ),
            {
              numRuns: 24,
              // Every mode runs on every run, so a leak in one branch only cannot pass by chance.
              examples: ALL_MODES.map((mode): [AiFailureMode, string, string] => [
                mode,
                'sk-Ex4mple_Key-012345678',
                '6f1c2a3b-4d5e-4f60-8a71-b2c3d4e5f607',
              ]),
            },
          )
        }, 120_000)
      })
    }
  })
}
