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

/** One turn of a conversation, as `chat()` takes it. */
interface Turn {
  role: 'user' | 'assistant'
  content: string
}

interface ChatReply {
  text: string
  stopReason: string
  usage: { inputTokens: number; outputTokens: number }
  model: string
}

type Chat = (
  messages: readonly Turn[],
  opts?: { system?: string; maxTokens?: number },
) => Promise<ChatReply>

/** How a stand-in answers every request of a failing build. */
export type AiFailureMode =
  | `status:${number}`
  | 'html:502'
  | 'no-text'
  | 'not-json'
  | 'hang'
  | 'unreachable'

/** A failing build: the adapter, and how many requests its provider has received. */
export interface AiFailingBuild {
  adapter: AiAdapter
  requests: () => number
  close: () => Promise<void>
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
   * `unreachable` echoes the key in its body and in a response header. Given, the suite adds the failure cases.
   */
  failing?: (mode: AiFailureMode, key: string, logger: Logger) => Promise<AiFailingBuild>
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

    const requests = options.requests
    if (requests !== undefined) {
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
                const prefix = `${provider} answered ${status}: `
                expect(message.slice(0, prefix.length)).toBe(prefix)
                expect(message, 'the key the provider echoed is not masked').toContain('***')
                expect(message.length - prefix.length).toBeLessThanOrEqual(300)
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
