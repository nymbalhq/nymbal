import { AdapterError, ConfigError, type ChatMessage, type ChatOptions } from '@nymbalhq/types'

// What every ai provider's chat() does alike: the input it refuses before a request, the time it waits, and the
// errors it throws. An error carries the provider and the HTTP status and nothing else: no cause, no headers, no
// request, so a key the provider echoes or a client library keeps never leaves the adapter.

export const DEFAULT_MAX_TOKENS = 1024
export const DEFAULT_TIMEOUT_MS = 60_000
/** The most of a provider's own error message an error passes on. */
const PROVIDER_MESSAGE_LIMIT = 300

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
  for (const [at, message] of messages.entries()) {
    const role: unknown = message?.role
    if (role !== 'user' && role !== 'assistant') {
      throw refuse(`messages[${at}].role is neither user nor assistant`)
    }
    if (at === 0 && role !== 'user') throw refuse('the first message is not the user’s')
    if (typeof message.content !== 'string' || message.content === '') {
      throw refuse(`messages[${at}].content is empty`)
    }
  }
  const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw refuse('maxTokens is not a positive integer')
  }
  return maxTokens
}

export const timedOut = (provider: string, timeoutMs: number): AdapterError =>
  new AdapterError('timeout', `${provider} gave no answer within ${timeoutMs} ms`, {
    context: { provider },
  })

/** `run` with an abort signal, rejecting `adapter.timeout` when it has not settled within `timeoutMs`. */
export async function bounded<T>(
  provider: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Rejected before the abort, so the timeout settles the race and not the aborted request's own error.
      reject(timedOut(provider, timeoutMs))
      controller.abort()
    }, timeoutMs)
  })
  try {
    return await Promise.race([run(controller.signal), expired])
  } finally {
    clearTimeout(timer)
  }
}

export const unreachable = (provider: string): AdapterError =>
  new AdapterError('unavailable', `${provider} could not be reached`, { context: { provider } })

/** A 2xx the adapter cannot read an answer from. */
export const unreadable = (provider: string, status: number, what: string): AdapterError =>
  new AdapterError('unexpected_response', `${provider} answered ${status} ${what}`, {
    context: { provider, status },
  })

function codeOf(status: number): string {
  if (status === 401 || status === 403) return 'auth_failed'
  if (status === 429) return 'rate_limited'
  if (status >= 400 && status < 500) return 'invalid_request'
  return 'unavailable'
}

/** The provider's message with the key masked as it is and in base64, cut to its limit. */
function masked(text: string, key: string): string {
  let out = text
  if (key !== '') {
    const bytes = Buffer.from(key, 'utf8')
    for (const form of [
      key,
      bytes.toString('base64').replace(/=+$/, ''),
      bytes.toString('base64url'),
    ]) {
      out = out.split(form).join('***')
    }
  }
  return out.slice(0, PROVIDER_MESSAGE_LIMIT)
}

/** A non-2xx answer, classified by its status; `providerMessage` is the provider's own, when its body had one. */
export function answered(
  provider: string,
  status: number,
  providerMessage: unknown,
  key: string,
): AdapterError {
  const said =
    typeof providerMessage === 'string' && providerMessage !== ''
      ? `: ${masked(providerMessage, key)}`
      : ''
  return new AdapterError(codeOf(status), `${provider} answered ${status}${said}`, {
    context: { provider, status },
  })
}

/** A JSON body, or undefined when the text is not JSON. */
export function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}
