import {
  AdapterError,
  ConfigError,
  type ChatMessage,
  type ChatOptions,
  type ChatToolCall,
} from '@nymbalhq/types'

// What every ai provider's chat() does alike: the input it refuses before a request, the time it waits, and the
// errors it throws. An error carries the provider and the HTTP status and nothing else: no cause, no headers and no
// request. Of a non-2xx body it keeps only the provider's error type and message, capped, with the key, anything
// shaped like a key and the conversation taken out, since a provider may echo any of them.

export const DEFAULT_MAX_TOKENS = 1024
export const DEFAULT_TIMEOUT_MS = 60_000
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/

/** The block's `timeoutMs`, or the default when it is unset. */
export function timeoutOf(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError('commerce.ai.config.timeoutMs is not a positive number of milliseconds', {
      context: { slot: 'ai' },
    })
  }
  return value
}

type Rec = Record<string, unknown>

export const isRecord = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const recOf = (value: unknown): Rec => (isRecord(value) ? value : {})

/** The maxTokens to send, once the input is one the provider would take. */
export function checkChat(
  provider: string,
  messages: readonly ChatMessage[],
  opts: ChatOptions | undefined,
): number {
  const refuse = (why: string) =>
    new AdapterError('invalid_request', `${provider} chat refused: ${why}`, {
      context: { provider },
    })
  if (!Array.isArray(messages) || messages.length === 0) throw refuse('no messages')
  // The calls of the nearest assistant turn that no tool turn has answered yet.
  let open: string[] = []
  for (const [at, message] of messages.entries()) {
    const turn = recOf(message)
    const role = turn['role']
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') {
      throw refuse(`messages[${at}].role is not user, assistant or tool`)
    }
    if (at === 0 && role !== 'user') throw refuse('the first message is not the user’s')
    const content = turn['content']
    if (typeof content !== 'string') throw refuse(`messages[${at}].content is not text`)
    if (role === 'tool') {
      const id = turn['toolCallId']
      if (typeof id !== 'string' || !open.includes(id)) {
        throw refuse(`messages[${at}] answers no open call of the assistant turn before it`)
      }
      if (content === '') throw refuse(`messages[${at}].content is empty`)
      open = open.filter((o) => o !== id)
      continue
    }
    if (open.length > 0) throw refuse(`messages[${at}] starts with a call left unanswered`)
    const calls = role === 'assistant' ? callIdsOf(turn['toolCalls'], at, refuse) : []
    if (content === '' && calls.length === 0) throw refuse(`messages[${at}].content is empty`)
    open = calls
  }
  checkTools(opts?.tools, refuse)
  const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw refuse('maxTokens is not a positive integer')
  }
  return maxTokens
}

/** An assistant turn's call ids, once each call is a well-formed one. */
function callIdsOf(value: unknown, at: number, refuse: (why: string) => AdapterError): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw refuse(`messages[${at}].toolCalls is not a list`)
  const ids: string[] = []
  for (const [n, call] of (value as unknown[]).entries()) {
    const c = recOf(call)
    const id = c['id']
    if (typeof id !== 'string' || id === '' || ids.includes(id)) {
      throw refuse(`messages[${at}].toolCalls[${n}].id is empty or repeated`)
    }
    if (typeof c['name'] !== 'string' || !TOOL_NAME.test(c['name'])) {
      throw refuse(`messages[${at}].toolCalls[${n}].name is outside ${TOOL_NAME.source}`)
    }
    if (!isRecord(c['args'])) throw refuse(`messages[${at}].toolCalls[${n}].args is not an object`)
    ids.push(id)
  }
  return ids
}

function checkTools(value: unknown, refuse: (why: string) => AdapterError): void {
  if (value === undefined) return
  if (!Array.isArray(value)) throw refuse('tools is not a list')
  const names = new Set<string>()
  for (const [at, tool] of (value as unknown[]).entries()) {
    const t = recOf(tool)
    const name = t['name']
    if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
      throw refuse(`tools[${at}].name is outside ${TOOL_NAME.source}`)
    }
    if (names.has(name)) throw refuse(`tools[${at}].name is taken by an earlier tool`)
    names.add(name)
    if (typeof t['description'] !== 'string') throw refuse(`tools[${at}].description is not text`)
    if (!isRecord(t['inputSchema'])) throw refuse(`tools[${at}].inputSchema is not an object`)
  }
}

/** A call the provider made, or undefined when its id or name is missing or its arguments are not a JSON object. */
export function callOf(id: unknown, name: unknown, args: unknown): ChatToolCall | undefined {
  if (typeof id !== 'string' || id === '' || typeof name !== 'string' || name === '')
    return undefined
  return isRecord(args) ? { id, name, args } : undefined
}

export const timedOut = (provider: string, timeoutMs: number): AdapterError =>
  new AdapterError('timeout', `${provider} gave no answer within ${timeoutMs} ms`, {
    context: { provider },
  })

export const cancelled = (provider: string): AdapterError =>
  new AdapterError('cancelled', `${provider} request cancelled by the caller`, {
    context: { provider },
  })

export const unreachable = (provider: string): AdapterError =>
  new AdapterError('unavailable', `${provider} could not be reached`, { context: { provider } })

/** A stream that ended, or reported an error, before its answer was complete. */
export const brokenOff = (provider: string): AdapterError =>
  new AdapterError('unavailable', `${provider} broke off its answer`, { context: { provider } })

/** A 2xx the adapter cannot read an answer from. */
export const unreadable = (provider: string, status: number, what: string): AdapterError =>
  new AdapterError('unexpected_response', `${provider} answered ${status} ${what}`, {
    context: { provider, status },
  })

/** The most of a provider's error message an error passes on. */
export const MESSAGE_CAP = 200
/** Conversation text shorter than this is not looked for in a provider's message. */
const ECHO_MIN = 8
const KEY_SHAPED = /\bsk-[A-Za-z0-9_-]{8,}/g
const ERROR_TYPE = /^[A-Za-z0-9_.-]{1,64}$/
// Anthropic's billing_error and a credit balance it reports on a 400; OpenAI's insufficient_quota (on a 429).
const BILLING_TYPES = new Set(['billing_error', 'insufficient_quota', 'billing_hard_limit_reached'])
const BILLING_TEXT = /credit balance/i
const REDACTED = '[redacted]'

/**
 * What a provider's message must not carry for one request: the key raw, as base64 (padded or not) and as
 * base64url, and the conversation's texts (a key-shaped token is taken out regardless).
 */
export function secretsOf(
  apiKey: string,
  messages: readonly ChatMessage[],
  opts: ChatOptions | undefined,
): string[] {
  const bytes = Buffer.from(apiKey, 'utf8')
  const texts = [opts?.system, ...messages.map((m) => m.content)].filter(
    (t): t is string => typeof t === 'string' && t.length >= ECHO_MIN,
  )
  return [
    apiKey,
    bytes.toString('base64'),
    bytes.toString('base64').replace(/=+$/, ''),
    bytes.toString('base64url'),
    ...texts,
  ]
}

interface Said {
  /** The provider's error type and code, where they are plain words. */
  kinds: string[]
  /** Its message on one line, the secrets taken out, not yet capped. */
  message: string
}

/** What a non-2xx body says: Anthropic's `{error: {type, message}}` or OpenAI's `{error: {message, type, code}}`. */
function saidOf(text: string, secrets: readonly string[]): Said {
  const error = recOf(recOf(jsonOf(text))['error'])
  const kinds = [error['type'], error['code']].filter(
    (k): k is string => typeof k === 'string' && ERROR_TYPE.test(k),
  )
  let message = typeof error['message'] === 'string' ? error['message'] : ''
  // Longest first, so a secret inside a longer one cannot leave the rest of the longer one behind.
  for (const secret of [...secrets].filter((s) => s !== '').sort((a, b) => b.length - a.length)) {
    message = message.split(secret).join(REDACTED)
  }
  message = message
    .replace(KEY_SHAPED, REDACTED)
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim()
  return { kinds, message }
}

function codeOf(status: number, said: Said): string {
  if (status === 401 || status === 403) return 'auth_failed'
  const billing =
    said.kinds.some((k) => BILLING_TYPES.has(k)) ||
    (status >= 400 && status < 500 && BILLING_TEXT.test(said.message))
  if (billing) return 'quota_exceeded'
  if (status === 529 || said.kinds.includes('overloaded_error')) return 'overloaded'
  if (status === 429) return 'rate_limited'
  if (status >= 400 && status < 500) return 'invalid_request'
  return 'unavailable'
}

function capped(message: string): string {
  const chars = Array.from(message)
  return chars.length <= MESSAGE_CAP ? message : `${chars.slice(0, MESSAGE_CAP - 1).join('')}…`
}

/**
 * A non-2xx answer, classified by its status and the error type its body names, with the provider's message (or its
 * type, when it gives no message) after the status.
 */
export function answered(
  provider: string,
  status: number,
  body = '',
  secrets: readonly string[] = [],
): AdapterError {
  const said = saidOf(body, secrets)
  const detail = said.message !== '' ? capped(said.message) : said.kinds[0]
  return new AdapterError(
    codeOf(status, said),
    `${provider} answered ${status}${detail === undefined ? '' : `: ${detail}`}`,
    { context: { provider, status } },
  )
}

/** A JSON body, or undefined when the text is not JSON. */
export function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** One request from its send to its last byte: the signal it is sent with, and why it was ended early. */
export interface Lifetime {
  signal: AbortSignal
  /** The timeout or the caller's abort, once either has ended the request. */
  ended(): AdapterError | undefined
  /** Clears the timer and closes the connection if it is still open. */
  close(): void
}

/** Bounds a request by `timeoutMs` (`adapter.timeout`) and by the caller's `signal` (`adapter.cancelled`). */
export function lifetime(provider: string, timeoutMs: number, caller?: AbortSignal): Lifetime {
  const controller = new AbortController()
  let reason: AdapterError | undefined
  // The reason is set before the abort, so the request's own abort error is read as it.
  const end = (error: AdapterError) => {
    if (reason !== undefined) return
    reason = error
    controller.abort()
  }
  const timer = setTimeout(() => end(timedOut(provider, timeoutMs)), timeoutMs)
  const onAbort = () => end(cancelled(provider))
  if (caller?.aborted === true) onAbort()
  else caller?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    ended: () => reason,
    close: () => {
      clearTimeout(timer)
      caller?.removeEventListener('abort', onAbort)
      controller.abort()
    },
  }
}

/**
 * POSTs `body` as JSON: the 2xx response, or the error a failure or a non-2xx answer is, the latter's message free of
 * `secrets` (`secretsOf`).
 */
export async function post(
  provider: string,
  url: string,
  headers: Record<string, string>,
  body: string,
  life: Lifetime,
  secrets: readonly string[],
): Promise<Response> {
  let response: Response
  try {
    response = await globalThis.fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body,
      signal: life.signal,
    })
  } catch {
    // fetch's own error may quote the request's headers, the key among them: none of it goes on.
    throw life.ended() ?? unreachable(provider)
  }
  if (response.status < 200 || response.status > 299) {
    let text = ''
    try {
      text = await response.text()
    } catch {
      // The timeout or the caller's abort ended the read: that, not the status, is why the request failed.
      const ended = life.ended()
      if (ended !== undefined) throw ended
      // A body cut short otherwise: the status alone.
    }
    throw answered(provider, response.status, text, secrets)
  }
  return response
}

/** The whole body as text, or the error a body cut short is. */
export async function bodyText(
  provider: string,
  response: Response,
  life: Lifetime,
): Promise<string> {
  try {
    return await response.text()
  } catch {
    throw life.ended() ?? brokenOff(provider)
  }
}
