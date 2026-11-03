import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// One rule-based "model" behind the two wire formats an ai adapter speaks: Anthropic's Messages API
// (`POST /v1/messages`, `x-api-key`) and OpenAI's chat completions (`POST <prefix>/chat/completions`, a Bearer key).
// The model reads the conversation, the system prompt and `max_tokens` only from the provider's own fields, so an
// adapter that drops or misplaces one gets a different answer:
// - "Reply with exactly the word X" in the last user turn: X.
// - A question about "the code word": the word after "The code word is" in an earlier user turn, else "I do not know."
// - "Count from 1 to N": the numbers 1 to N.
// - Upper case when the provider's system field asks for "upper case".
// - More words than `max_tokens`: the first `max_tokens` words, with the provider's length stop reason.
// Usage is counted in words. Every request is recorded with its headers, its body and the key it carried.
//
// Modes: `model` answers as above; `stop:<reason>` answers as the model with that wire stop reason; `status:<n>`
// answers n with the provider's JSON error body; `html:<n>` answers n with an HTML page; `no-text` answers 200 with
// no text; `not-json` answers 200 with a body that is not JSON; `hang` accepts the request and never answers. Every
// mode but `model` and `stop:` echoes the key it received: in the error message (raw, base64 and base64url), in the
// body and in an `x-echo` header.

export type AiWire = 'anthropic' | 'openai'

export type AiStandInMode =
  | 'model'
  | `stop:${string}`
  | `status:${number}`
  | `html:${number}`
  | 'no-text'
  | 'not-json'
  | 'hang'

export interface AiStandInRequest {
  method: string
  /** The request path, without the query. */
  path: string
  headers: IncomingHttpHeaders
  /** The parsed JSON body, or the raw text when it is not JSON. */
  body: unknown
  /** The key it carried: `x-api-key` on Anthropic's wire, the Bearer token on OpenAI's. */
  credential: string | undefined
}

/** What the model answered to one request, in the units it reports. */
export interface AiStandInAnswer {
  text: string
  /** The model name it reported, which is not the one it was asked for. */
  model: string
  inputWords: number
  outputWords: number
  /** The wire stop reason it sent. */
  stop: string
}

export interface AiStandIn {
  wire: AiWire
  /** `http://127.0.0.1:<port>`: Anthropic's baseUrl as it is; OpenAI's with the path prefix the test chooses. */
  url: string
  mode: AiStandInMode
  requests: AiStandInRequest[]
  answers: AiStandInAnswer[]
  credentials(): Array<string | undefined>
  reset(): void
  close(): Promise<void>
}

const HOST = '127.0.0.1'

interface Conversation {
  system: string
  turns: Array<{ role: string; content: string }>
  maxTokens: number | undefined
  model: string
}

/** A content field as text: a string, or the text of each `{ type: 'text', text }` part. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'object' &&
        part !== null &&
        typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('')
  }
  return ''
}

function conversationOf(wire: AiWire, body: unknown): Conversation {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const messages = Array.isArray(b['messages'])
    ? (b['messages'] as Array<Record<string, unknown>>)
    : []
  const maxTokens = typeof b['max_tokens'] === 'number' ? b['max_tokens'] : undefined
  const model = typeof b['model'] === 'string' ? b['model'] : ''
  if (wire === 'anthropic') {
    return {
      system: textOf(b['system']),
      turns: messages.map((m) => ({ role: String(m['role']), content: textOf(m['content']) })),
      maxTokens,
      model,
    }
  }
  return {
    system: messages
      .filter((m) => m['role'] === 'system')
      .map((m) => textOf(m['content']))
      .join('\n'),
    turns: messages
      .filter((m) => m['role'] !== 'system')
      .map((m) => ({ role: String(m['role']), content: textOf(m['content']) })),
    maxTokens,
    model,
  }
}

const words = (text: string): string[] => text.split(/\s+/).filter((w) => w !== '')

function reply(c: Conversation): { text: string; truncated: boolean; inputWords: number } {
  const userTurns = c.turns.filter((t) => t.role === 'user')
  const last = userTurns.at(-1)?.content ?? ''
  let text: string
  const exact = /Reply with exactly the word ([A-Za-z0-9_-]+)/.exec(last)
  const count = /Count from 1 to (\d+)/.exec(last)
  if (exact) text = exact[1]!
  else if (/code word/i.test(last)) {
    const earlier = userTurns
      .slice(0, -1)
      .map((t) => /The code word is ([A-Za-z0-9_-]+)/.exec(t.content)?.[1])
      .find((w) => w !== undefined)
    text = earlier ?? 'I do not know.'
  } else if (count) {
    text = Array.from({ length: Number(count[1]) }, (_, i) => String(i + 1)).join(' ')
  } else if (/hello/i.test(last)) text = 'Hello there.'
  else text = 'Noted.'
  if (/upper case/i.test(c.system)) text = text.toUpperCase()
  let truncated = false
  if (c.maxTokens !== undefined && words(text).length > c.maxTokens) {
    text = words(text).slice(0, Math.max(c.maxTokens, 0)).join(' ')
    truncated = true
  }
  const inputWords = [c.system, ...c.turns.map((t) => t.content)].reduce(
    (n, t) => n + words(t).length,
    0,
  )
  return { text, truncated, inputWords }
}

/** The provider's own error message, echoing the key three ways, and longer than an adapter may pass on. */
function echoMessage(key: string): string {
  const b64 = Buffer.from(key, 'utf8').toString('base64')
  const b64url = Buffer.from(key, 'utf8').toString('base64url')
  return `Incorrect API key provided: ${key} (${b64}, ${b64url}). ${'You can find your API key in your account settings. '.repeat(8)}`
}

function anthropicErrorType(status: number): string {
  if (status === 401) return 'authentication_error'
  if (status === 403) return 'permission_error'
  if (status === 429) return 'rate_limit_error'
  if (status === 529) return 'overloaded_error'
  if (status >= 500) return 'api_error'
  return 'invalid_request_error'
}

function credentialOf(wire: AiWire, headers: IncomingHttpHeaders): string | undefined {
  if (wire === 'anthropic') {
    const key = headers['x-api-key']
    return typeof key === 'string' ? key : undefined
  }
  const auth = headers['authorization']
  return typeof auth === 'string' && auth.startsWith('Bearer ')
    ? auth.slice('Bearer '.length)
    : auth
}

function onWirePath(wire: AiWire, path: string): boolean {
  return wire === 'anthropic' ? path === '/v1/messages' : path.endsWith('/chat/completions')
}

/** A stand-in for `wire`'s API on a free port of 127.0.0.1, answering as `mode` until the test changes it. */
export async function startAiStandIn(
  wire: AiWire,
  mode: AiStandInMode = 'model',
): Promise<AiStandIn> {
  const standIn: AiStandIn = {
    wire,
    url: '',
    mode,
    requests: [],
    answers: [],
    credentials: () => standIn.requests.map((r) => r.credential),
    reset: () => {
      standIn.requests.length = 0
      standIn.answers.length = 0
    },
    close: async () => undefined,
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown = raw
      try {
        body = JSON.parse(raw)
      } catch {
        // kept as text
      }
      const path = (req.url ?? '').split('?')[0] ?? ''
      const credential = credentialOf(wire, req.headers)
      standIn.requests.push({
        method: req.method ?? 'GET',
        path,
        headers: req.headers,
        body,
        credential,
      })
      const key = credential ?? ''
      const now = standIn.mode

      const send = (status: number, payload: string, type = 'application/json') => {
        res.writeHead(status, {
          'content-type': type,
          ...(now !== 'model' && !now.startsWith('stop:') && { 'x-echo': key }),
        })
        res.end(payload)
      }

      if (now === 'hang') return
      if (req.method !== 'POST' || !onWirePath(wire, path)) {
        return send(
          404,
          JSON.stringify({ error: { type: 'not_found_error', message: `no route ${path}` } }),
        )
      }
      if (now.startsWith('status:')) {
        const status = Number(now.slice('status:'.length))
        const message = echoMessage(key)
        return send(
          status,
          JSON.stringify(
            wire === 'anthropic'
              ? { type: 'error', error: { type: anthropicErrorType(status), message } }
              : { error: { message, type: 'invalid_request_error', param: null, code: null } },
          ),
        )
      }
      if (now.startsWith('html:')) {
        const status = Number(now.slice('html:'.length))
        return send(
          status,
          `<html><head><title>${status} Bad Gateway</title></head><body><h1>${status}</h1><p>${key}</p></body></html>`,
          'text/html',
        )
      }
      if (now === 'not-json') return send(200, `Key ${key} is not JSON <html>`)

      const c = conversationOf(wire, body)
      const answered = reply(c)
      const model = `${c.model || 'model'}-stand-in-2099`
      const noText = now === 'no-text'
      const wireStop = now.startsWith('stop:')
        ? now.slice('stop:'.length)
        : answered.truncated
          ? wire === 'anthropic'
            ? 'max_tokens'
            : 'length'
          : wire === 'anthropic'
            ? 'end_turn'
            : 'stop'
      const outputWords = noText ? 0 : words(answered.text).length
      standIn.answers.push({
        text: noText ? '' : answered.text,
        model,
        inputWords: answered.inputWords,
        outputWords,
        stop: wireStop,
      })
      if (wire === 'anthropic') {
        return send(
          200,
          JSON.stringify({
            id: `msg_stand_in_${standIn.answers.length}`,
            type: 'message',
            role: 'assistant',
            model,
            content: noText ? [] : [{ type: 'text', text: answered.text }],
            stop_reason: wireStop,
            stop_sequence: null,
            usage: { input_tokens: answered.inputWords, output_tokens: outputWords },
          }),
        )
      }
      return send(
        200,
        JSON.stringify({
          id: `chatcmpl-stand-in-${standIn.answers.length}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: noText ? null : answered.text },
              finish_reason: wireStop,
            },
          ],
          usage: {
            prompt_tokens: answered.inputWords,
            completion_tokens: outputWords,
            total_tokens: answered.inputWords + outputWords,
          },
        }),
      )
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, HOST, resolve))
  standIn.url = `http://${HOST}:${(server.address() as AddressInfo).port}`
  standIn.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return standIn
}

/** A URL on 127.0.0.1 whose port nothing listens on: a connection to it is refused. */
export async function refusedUrl(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, HOST, resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://${HOST}:${port}`
}

/** The text of a recorded message's content, a string or text parts. */
export function contentText(content: unknown): string {
  return textOf(content)
}
