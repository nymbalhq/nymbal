import { createHash } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

// One rule-based "model" behind the two wire formats an ai adapter speaks: Anthropic's Messages API
// (`POST /v1/messages`, `x-api-key`) and OpenAI's chat completions (`POST <prefix>/chat/completions`, a Bearer key).
// The model reads the conversation, the system prompt, the tools and the length bound only from the provider's own
// fields, so an adapter that drops or misplaces one gets a different answer:
// - The last turn a tool result (Anthropic: a user turn of `tool_result` blocks; OpenAI: `role: 'tool'` turns): the
//   content of the trailing tool results, joined by a space.
// - "Use the X tool" in the last user turn, X among the tools offered (Anthropic `tools[].name` beside an
//   `input_schema`; OpenAI `tools[].function.name` beside `parameters`): one call to X, no text, with the word after
//   "SKU" as `sku` (`{}` when there is none). Its id is derived from the conversation, so the same conversation gets
//   the same id, streamed or not.
// - "Reply with exactly the word X" in the last user turn: X.
// - A question about "the code word": the word after "The code word is" in an earlier user turn, else "I do not know."
// - "Count from 1 to N": the numbers 1 to N.
// - Upper case when the provider's system field asks for "upper case".
// - More words than the length bound (`max_completion_tokens`, else `max_tokens`): the first that many words, with the
//   provider's length stop reason.
// A conversation the provider itself would refuse with 400 is refused the same way: a tool result whose id is not a
// call of the assistant turn just before it, or a call left unanswered when the next turn starts.
// Usage is counted in words. On Anthropic's wire a request with a top-level `cache_control` is cached as the provider's
// automatic caching does: a prompt of fewer than `MIN_CACHED_WORDS` words is not cached (the provider's minimum
// cacheable length), and a longer one reads the longest prefix (model, tools, system and its first turns, as parsed) an
// earlier such request ended on, writes the rest, and reports them as `cache_read_input_tokens` and
// `cache_creation_input_tokens` apart from `input_tokens`. Every request is recorded with its headers, its body, the key it carried and whether the
// client closed the connection before the stand-in finished answering.
//
// `stream: true` answers as server-sent events in the wire's own format, one word per text delta (the deltas
// concatenate to the text), a call's arguments split over several deltas, usage where the wire reports it (OpenAI only
// when `stream_options.include_usage` asks).
//
// Modes: `model` answers as above; `stop:<reason>` answers as the model with that wire stop reason; `status:<n>`
// answers n with the provider's JSON error body; `html:<n>` answers n with an HTML page; `no-text` answers 200 with
// no text and no call; `not-json` answers 200 with a body that is not JSON; `hang` accepts the request and never
// answers; `bad-tool-args:<array|string|null|not-json>` answers some text and one call to the first tool offered whose
// arguments are not a JSON object. On a stream request only (any other request is answered as `model`): `stream-break` sends the
// first two text deltas and destroys the connection; `stream-error` sends one text delta and then the provider's
// mid-stream error (Anthropic's `event: error` overloaded, OpenAI's error chunk); `stream-stall` sends one text delta
// and then nothing, holding the connection. Every mode but `model`, `stop:`, `bad-tool-args:` and `script` echoes the
// key it received: in the error message (raw, base64 and base64url), in the body and in an `x-echo` header; the error
// messages of `status:` and `stream-error` echo the last user turn's text too.
//
// `script` answers what the stand-in's `script` returns for the request's conversation (`ScriptView`, the same on both
// wires): its text and its calls (ids made here, unique per stand-in), streamed or not as the request asks, waiting
// `delayMs` before each text delta of a stream (before the whole answer otherwise) and stopping once the client has
// gone. A reply with `fail` answers that request as that mode instead (`status:500`, `hang`, ...).

export type AiWire = 'anthropic' | 'openai'

export type AiStandInMode =
  | 'model'
  | `stop:${string}`
  | `status:${number}`
  | `html:${number}`
  | 'no-text'
  | 'not-json'
  | 'hang'
  | `bad-tool-args:${'array' | 'string' | 'null' | 'not-json'}`
  | 'stream-break'
  | 'stream-error'
  | 'stream-stall'
  | 'script'

/** One turn of a conversation as a script reads it, whatever wire it came on. */
export interface ScriptTurn {
  role: 'user' | 'assistant' | 'tool' | string
  content: string
  /** An assistant turn's calls, with their arguments as objects. */
  calls: AiStandInCall[]
  /** A tool turn's call id. */
  answers?: string
  /** A tool turn sent as an error (Anthropic's `is_error`; OpenAI's wire has no such flag). */
  isError?: boolean
}

/** A request's conversation as a script reads it. */
export interface ScriptView {
  /** The request's position among those the stand-in received, from 0. */
  index: number
  system: string
  turns: ScriptTurn[]
  /** The names of the tools offered, in order. */
  tools: string[]
  stream: boolean
}

export interface ScriptReply {
  text?: string
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>
  /** Waits this long before each text delta of a stream, or before the whole answer of any other request. */
  delayMs?: number
  /** Answers this request as that mode instead. */
  fail?: Exclude<AiStandInMode, 'model' | 'script'>
}

export type AiScript = (view: ScriptView) => ScriptReply | Promise<ScriptReply>

export interface AiStandInRequest {
  method: string
  /** The request path, without the query. */
  path: string
  headers: IncomingHttpHeaders
  /** The parsed JSON body, or the raw text when it is not JSON. */
  body: unknown
  /** The key it carried: `x-api-key` on Anthropic's wire, the Bearer token on OpenAI's. */
  credential: string | undefined
  /** The client closed the connection before the stand-in finished its answer (an abort, a timeout). */
  closedEarly: boolean
}

/** A call the model made, as the stand-in meant it (the arguments as an object, whatever went on the wire). */
export interface AiStandInCall {
  id: string
  name: string
  args: Record<string, unknown>
}

/** What the model answered to one request, in the units it reports. */
export interface AiStandInAnswer {
  text: string
  /** The model name it reported, which is not the one it was asked for. */
  model: string
  /** Every input word, cached or not. */
  inputWords: number
  /** Of `inputWords`, those read from the prompt cache and those written to it (Anthropic's wire; 0 otherwise). */
  cacheReadWords: number
  cacheWrittenWords: number
  outputWords: number
  /** The wire stop reason it sent. */
  stop: string
  /** The calls it made, in order. */
  toolCalls: AiStandInCall[]
  /** The text deltas it sent on a stream, in order (all of them, or those before a break); [] when not streamed. */
  deltas: string[]
}

export interface AiStandIn {
  wire: AiWire
  /** `http://127.0.0.1:<port>`: Anthropic's baseUrl as it is; OpenAI's with the path prefix the test chooses. */
  url: string
  mode: AiStandInMode
  /** What `script` mode answers. */
  script: AiScript | undefined
  /** What the script threw, per request it threw on (each such request was answered 500). */
  scriptErrors: unknown[]
  requests: AiStandInRequest[]
  answers: AiStandInAnswer[]
  credentials(): Array<string | undefined>
  reset(): void
  close(): Promise<void>
}

const HOST = '127.0.0.1'

/** One turn as the model reads it, whatever wire it came on. */
interface Turn {
  role: 'user' | 'assistant' | 'tool' | string
  content: string
  calls: Array<{ id: string; name: string }>
  /** A tool result's call id. */
  answers?: string
}

interface Conversation {
  system: string
  turns: Turn[]
  tools: string[]
  maxTokens: number | undefined
  model: string
  stream: boolean
  includeUsage: boolean
}

type Rec = Record<string, unknown>
const recOf = (value: unknown): Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : {}

/** A content field as text: a string, or the text of each `{ type: 'text', text }` part. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type !== 'tool_result' &&
        typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('')
  }
  return ''
}

function anthropicTurns(messages: Rec[]): Turn[] {
  const turns: Turn[] = []
  for (const m of messages) {
    const role = String(m['role'])
    const blocks = Array.isArray(m['content']) ? (m['content'] as unknown[]).map(recOf) : []
    const results = blocks.filter((b) => b['type'] === 'tool_result')
    if (results.length > 0) {
      // A tool_result anywhere but a user turn is not a tool result the provider takes.
      for (const r of results) {
        turns.push({
          role: role === 'user' ? 'tool' : `${role}:tool_result`,
          content: textOf(r['content']),
          calls: [],
          answers: String(r['tool_use_id'] ?? ''),
        })
      }
      const text = textOf(blocks.filter((b) => b['type'] === 'text'))
      if (text !== '') turns.push({ role, content: text, calls: [] })
      continue
    }
    turns.push({
      role,
      content: textOf(m['content']),
      calls: blocks
        .filter((b) => b['type'] === 'tool_use')
        .map((b) => ({ id: String(b['id'] ?? ''), name: String(b['name'] ?? '') })),
    })
  }
  return turns
}

function openaiTurns(messages: Rec[]): Turn[] {
  return messages
    .filter((m) => m['role'] !== 'system')
    .map((m) => {
      const role = String(m['role'])
      const calls = Array.isArray(m['tool_calls'])
        ? (m['tool_calls'] as unknown[]).map(recOf).map((c) => ({
            id: String(c['id'] ?? ''),
            name: String(recOf(c['function'])['name'] ?? ''),
          }))
        : []
      return {
        role,
        content: textOf(m['content']),
        calls,
        ...(role === 'tool' && { answers: String(m['tool_call_id'] ?? '') }),
      }
    })
}

function conversationOf(wire: AiWire, body: unknown): Conversation {
  const b = recOf(body)
  const messages = Array.isArray(b['messages']) ? (b['messages'] as unknown[]).map(recOf) : []
  const bound = (field: string) => (typeof b[field] === 'number' ? (b[field] as number) : undefined)
  const maxTokens = bound('max_completion_tokens') ?? bound('max_tokens')
  const model = typeof b['model'] === 'string' ? b['model'] : ''
  const toolList = Array.isArray(b['tools']) ? (b['tools'] as unknown[]).map(recOf) : []
  const stream = b['stream'] === true
  if (wire === 'anthropic') {
    return {
      system: textOf(b['system']),
      turns: anthropicTurns(messages),
      tools: toolList
        .filter((t) => typeof t['name'] === 'string' && typeof t['input_schema'] === 'object')
        .map((t) => t['name'] as string),
      maxTokens,
      model,
      stream,
      includeUsage: true,
    }
  }
  return {
    system: messages
      .filter((m) => m['role'] === 'system')
      .map((m) => textOf(m['content']))
      .join('\n'),
    turns: openaiTurns(messages),
    tools: toolList
      .filter((t) => t['type'] === 'function')
      .map((t) => recOf(t['function']))
      .filter((f) => typeof f['name'] === 'string' && typeof f['parameters'] === 'object')
      .map((f) => f['name'] as string),
    maxTokens,
    model,
    stream,
    includeUsage: recOf(b['stream_options'])['include_usage'] === true,
  }
}

function argsOf(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return recOf(JSON.parse(value))
    } catch {
      return {}
    }
  }
  return recOf(value)
}

function anthropicScriptTurns(messages: Rec[]): ScriptTurn[] {
  const turns: ScriptTurn[] = []
  for (const m of messages) {
    const role = String(m['role'])
    const blocks = Array.isArray(m['content']) ? (m['content'] as unknown[]).map(recOf) : []
    const results = blocks.filter((b) => b['type'] === 'tool_result')
    for (const r of results) {
      turns.push({
        role: role === 'user' ? 'tool' : `${role}:tool_result`,
        content: textOf(r['content']),
        calls: [],
        answers: String(r['tool_use_id'] ?? ''),
        ...(r['is_error'] === true && { isError: true }),
      })
    }
    const text = textOf(m['content'])
    const calls = blocks
      .filter((b) => b['type'] === 'tool_use')
      .map((b) => ({
        id: String(b['id'] ?? ''),
        name: String(b['name'] ?? ''),
        args: argsOf(b['input']),
      }))
    if (results.length === 0 || text !== '' || calls.length > 0)
      turns.push({ role, content: text, calls })
  }
  return turns
}

function openaiScriptTurns(messages: Rec[]): ScriptTurn[] {
  return messages
    .filter((m) => m['role'] !== 'system')
    .map((m) => {
      const role = String(m['role'])
      const calls = Array.isArray(m['tool_calls'])
        ? (m['tool_calls'] as unknown[]).map(recOf).map((c) => ({
            id: String(c['id'] ?? ''),
            name: String(recOf(c['function'])['name'] ?? ''),
            args: argsOf(recOf(c['function'])['arguments']),
          }))
        : []
      return {
        role,
        content: textOf(m['content']),
        calls,
        ...(role === 'tool' && { answers: String(m['tool_call_id'] ?? '') }),
      }
    })
}

/** A recorded request's body as a script reads it (`index` is the caller's to set). */
export function scriptViewOf(wire: AiWire, body: unknown, index = 0): ScriptView {
  const b = recOf(body)
  const messages = Array.isArray(b['messages']) ? (b['messages'] as unknown[]).map(recOf) : []
  const c = conversationOf(wire, body)
  return {
    index,
    system: c.system,
    turns: wire === 'anthropic' ? anthropicScriptTurns(messages) : openaiScriptTurns(messages),
    tools: c.tools,
    stream: c.stream,
  }
}

/** Why the provider would refuse this conversation's tool turns with a 400, or undefined when it would not. */
function toolTurnRefusal(turns: Turn[]): string | undefined {
  let open: string[] = []
  let answerable: string[] = []
  for (const turn of turns) {
    if (turn.role === 'tool') {
      if (turn.answers === undefined || !answerable.includes(turn.answers)) {
        return `tool result ${String(turn.answers)} answers no call of the assistant turn before it`
      }
      open = open.filter((id) => id !== turn.answers)
      continue
    }
    if (turn.role.endsWith(':tool_result')) return 'a tool result outside a user turn'
    if (open.length > 0) return `call ${open[0]!} has no tool result before the next turn`
    answerable = turn.role === 'assistant' ? turn.calls.map((c) => c.id) : []
    open = [...answerable]
  }
  return undefined
}

const words = (text: string): string[] => text.split(/\s+/).filter((w) => w !== '')

/** The text as one-word deltas whose concatenation is the text. */
const deltasOf = (text: string): string[] => (text === '' ? [] : text.split(/(?<=\s)(?=\S)/))

function callId(wire: AiWire, c: Conversation, name: string): string {
  const hash = createHash('sha256')
    .update(JSON.stringify([c.system, c.turns, name]))
    .digest('hex')
  return `${wire === 'anthropic' ? 'toolu' : 'call'}_stand_in_${hash.slice(0, 20)}`
}

interface Reply {
  text: string
  calls: AiStandInCall[]
  truncated: boolean
  inputWords: number
}

function reply(wire: AiWire, c: Conversation): Reply {
  const userTurns = c.turns.filter((t) => t.role === 'user')
  const last = userTurns.at(-1)?.content ?? ''
  const inputWords = [c.system, ...c.turns.map((t) => t.content)].reduce(
    (n, t) => n + words(t).length,
    0,
  )
  const trailing: string[] = []
  for (let i = c.turns.length - 1; i >= 0 && c.turns[i]!.role === 'tool'; i--) {
    trailing.unshift(c.turns[i]!.content)
  }
  const use = /Use the ([A-Za-z0-9_-]+) tool/.exec(last)
  if (trailing.length === 0 && use && c.tools.includes(use[1]!)) {
    const sku = /SKU\s+([A-Za-z0-9_-]+)/.exec(last)?.[1]
    const name = use[1]!
    return {
      text: '',
      calls: [{ id: callId(wire, c, name), name, args: sku === undefined ? {} : { sku } }],
      truncated: false,
      inputWords,
    }
  }
  let text: string
  const exact = /Reply with exactly the word ([A-Za-z0-9_-]+)/.exec(last)
  const count = /Count from 1 to (\d+)/.exec(last)
  if (trailing.length > 0) text = trailing.join(' ')
  else if (exact) text = exact[1]!
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
  return { text, calls: [], truncated, inputWords }
}

/** The provider's own error message, echoing the key three ways and the last user turn, and longer than an adapter may pass on. */
function echoMessage(key: string, lastUser: string): string {
  const b64 = Buffer.from(key, 'utf8').toString('base64')
  const b64url = Buffer.from(key, 'utf8').toString('base64url')
  return `Refused "${lastUser}": incorrect API key provided: ${key} (${b64}, ${b64url}). ${'You can find your API key in your account settings. '.repeat(8)}`
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

/** Arguments that are not a JSON object, as the wire carries them: Anthropic's `input` value, OpenAI's string. */
function badArgs(variant: string): { input: unknown; text: string } {
  if (variant === 'array') return { input: ['A-17'], text: '["A-17"]' }
  if (variant === 'string') return { input: 'A-17', text: '"A-17"' }
  if (variant === 'null') return { input: null, text: 'null' }
  return { input: '{"sku": "A-1', text: '{"sku": "A-1' }
}

/** A JSON text cut in three pieces, so no single delta is a complete argument object. */
function piecesOf(json: string): string[] {
  const a = Math.max(1, Math.floor(json.length / 3))
  const b = Math.max(a + 1, Math.floor((2 * json.length) / 3))
  return [json.slice(0, a), json.slice(a, b), json.slice(b)].filter((p) => p !== '')
}

const sse = (res: ServerResponse, event: string | undefined, data: unknown): void => {
  res.write(
    `${event === undefined ? '' : `event: ${event}\n`}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`,
  )
}

/** The stand-in's minimum cacheable prompt, in words: Anthropic processes a shorter prompt without caching it. */
export const MIN_CACHED_WORDS = 8

/**
 * What Anthropic's automatic caching reads and writes for `body`, in words of its `total`, recording the prefix it ends
 * on in `cache`; nothing when the request asks for no caching or is shorter than `MIN_CACHED_WORDS`.
 */
function cachedOf(
  body: unknown,
  total: number,
  cache: Map<string, number>,
): { read: number; written: number } {
  const b = recOf(body)
  if (recOf(b['cache_control'])['type'] !== 'ephemeral' || total < MIN_CACHED_WORDS) {
    return { read: 0, written: 0 }
  }
  const messages = Array.isArray(b['messages']) ? (b['messages'] as unknown[]) : []
  const keyOf = (n: number) =>
    createHash('sha256')
      .update(
        JSON.stringify([b['model'], b['tools'] ?? null, b['system'] ?? null, messages.slice(0, n)]),
      )
      .digest('hex')
  let read = 0
  for (let n = messages.length; n > 0; n--) {
    const hit = cache.get(keyOf(n))
    if (hit !== undefined) {
      read = hit
      break
    }
  }
  cache.set(keyOf(messages.length), total)
  return { read, written: total - read }
}

/** A stand-in for `wire`'s API on a free port of 127.0.0.1, answering as `mode` until the test changes it. */
export async function startAiStandIn(
  wire: AiWire,
  mode: AiStandInMode = 'model',
  script?: AiScript,
): Promise<AiStandIn> {
  let scriptCalls = 0
  const promptCache = new Map<string, number>()
  const standIn: AiStandIn = {
    wire,
    url: '',
    mode,
    script,
    scriptErrors: [],
    requests: [],
    answers: [],
    credentials: () => standIn.requests.map((r) => r.credential),
    reset: () => {
      standIn.requests.length = 0
      standIn.answers.length = 0
      standIn.scriptErrors.length = 0
      promptCache.clear()
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
      const record: AiStandInRequest = {
        method: req.method ?? 'GET',
        path,
        headers: req.headers,
        body,
        credential,
        closedEarly: false,
      }
      standIn.requests.push(record)
      let destroyedHere = false
      res.on('close', () => {
        if (!res.writableFinished && !destroyedHere) record.closedEarly = true
      })
      const key = credential ?? ''
      let now: AiStandInMode = standIn.mode
      let scripted: ScriptReply | undefined
      if (now === 'script') {
        try {
          if (standIn.script === undefined) throw new Error('script mode with no script')
          scripted = await standIn.script(
            scriptViewOf(wire, body, standIn.requests.indexOf(record)),
          )
        } catch (error) {
          // A script that throws is the test's own fault: kept for the test to show, answered as a provider error.
          standIn.scriptErrors.push(error)
          scripted = { fail: 'status:500' }
        }
        if (scripted.fail !== undefined) {
          now = scripted.fail
          scripted = undefined
        }
      }
      const delayMs = scripted?.delayMs ?? 0
      const echoes =
        now !== 'model' &&
        now !== 'script' &&
        !now.startsWith('stop:') &&
        !now.startsWith('bad-tool-args:')

      const send = (status: number, payload: string, type = 'application/json') => {
        res.writeHead(status, { 'content-type': type, ...(echoes && { 'x-echo': key }) })
        res.end(payload)
      }

      if (now === 'hang') return
      if (req.method !== 'POST' || !onWirePath(wire, path)) {
        return send(
          404,
          JSON.stringify({ error: { type: 'not_found_error', message: `no route ${path}` } }),
        )
      }
      const c = conversationOf(wire, body)
      const lastUser = c.turns.filter((t) => t.role === 'user').at(-1)?.content ?? ''
      const refuse = (status: number, message: string) =>
        send(
          status,
          JSON.stringify(
            wire === 'anthropic'
              ? { type: 'error', error: { type: anthropicErrorType(status), message } }
              : { error: { message, type: 'invalid_request_error', param: null, code: null } },
          ),
        )
      if (now.startsWith('status:')) {
        return refuse(Number(now.slice('status:'.length)), echoMessage(key, lastUser))
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
      const refusal = toolTurnRefusal(c.turns)
      if (refusal !== undefined) return refuse(400, refusal)

      const answered: Reply =
        scripted === undefined
          ? reply(wire, c)
          : {
              text: scripted.text ?? '',
              calls: (scripted.toolCalls ?? []).map((call) => {
                scriptCalls += 1
                return {
                  id: `${wire === 'anthropic' ? 'toolu' : 'call'}_script_${scriptCalls}`,
                  name: call.name,
                  args: call.args,
                }
              }),
              truncated: false,
              inputWords: reply(wire, c).inputWords,
            }
      const noText = now === 'no-text'
      const bad = now.startsWith('bad-tool-args:')
        ? badArgs(now.slice('bad-tool-args:'.length))
        : undefined
      // A bad call comes with text, so only the call's arguments can make the reply unreadable.
      const text = noText ? '' : bad !== undefined ? 'Let me look that up.' : answered.text
      const calls: AiStandInCall[] = noText
        ? []
        : bad !== undefined
          ? [
              {
                id: callId(wire, c, c.tools[0] ?? 'lookup_price'),
                name: c.tools[0] ?? 'lookup_price',
                args: {},
              },
            ]
          : answered.calls
      const model = `${c.model || 'model'}-stand-in-2099`
      const wireStop = now.startsWith('stop:')
        ? now.slice('stop:'.length)
        : calls.length > 0
          ? wire === 'anthropic'
            ? 'tool_use'
            : 'tool_calls'
          : answered.truncated
            ? wire === 'anthropic'
              ? 'max_tokens'
              : 'length'
            : wire === 'anthropic'
              ? 'end_turn'
              : 'stop'
      const outputWords = words(text).length
      const cached =
        wire === 'anthropic'
          ? cachedOf(body, answered.inputWords, promptCache)
          : { read: 0, written: 0 }
      const inputUsage = {
        input_tokens: answered.inputWords - cached.read - cached.written,
        cache_creation_input_tokens: cached.written,
        cache_read_input_tokens: cached.read,
      }
      const answer: AiStandInAnswer = {
        text,
        model,
        inputWords: answered.inputWords,
        cacheReadWords: cached.read,
        cacheWrittenWords: cached.written,
        outputWords,
        stop: wireStop,
        toolCalls: calls,
        deltas: [],
      }
      standIn.answers.push(answer)
      const argsText = (call: AiStandInCall) => bad?.text ?? JSON.stringify(call.args)
      const argsInput = (call: AiStandInCall) => (bad === undefined ? call.args : bad.input)

      const gone = () => res.destroyed || record.closedEarly
      const pause = () => new Promise((resolve) => setTimeout(resolve, delayMs))

      if (!c.stream) {
        if (delayMs > 0) await pause()
        if (gone()) return
        if (wire === 'anthropic') {
          return send(
            200,
            JSON.stringify({
              id: `msg_stand_in_${standIn.answers.length}`,
              type: 'message',
              role: 'assistant',
              model,
              content: [
                ...(text === '' ? [] : [{ type: 'text', text }]),
                ...calls.map((call) => ({
                  type: 'tool_use',
                  id: call.id,
                  name: call.name,
                  input: argsInput(call),
                })),
              ],
              stop_reason: wireStop,
              stop_sequence: null,
              usage: { ...inputUsage, output_tokens: outputWords },
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
                message: {
                  role: 'assistant',
                  content: text === '' ? null : text,
                  ...(calls.length > 0 && {
                    tool_calls: calls.map((call) => ({
                      id: call.id,
                      type: 'function',
                      function: { name: call.name, arguments: argsText(call) },
                    })),
                  }),
                },
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
      }

      // A stream: the head, the text deltas (all, or those a stream mode lets through), then the calls and the end.
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        ...(echoes && { 'x-echo': key }),
      })
      const id = `${wire === 'anthropic' ? 'msg' : 'chatcmpl'}_stand_in_${standIn.answers.length}`
      const chunk = (delta: Rec, finish: string | null = null) =>
        sse(res, undefined, {
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })
      if (wire === 'anthropic') {
        sse(res, 'message_start', {
          type: 'message_start',
          message: {
            id,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { ...inputUsage, output_tokens: 0 },
          },
        })
        sse(res, 'ping', { type: 'ping' })
      } else {
        chunk({ role: 'assistant', content: '' })
      }
      const all = deltasOf(text)
      const cut =
        now === 'stream-break'
          ? 2
          : now === 'stream-error' || now === 'stream-stall'
            ? 1
            : all.length
      const sent = all.slice(0, cut)
      if (wire === 'anthropic' && sent.length > 0) {
        sse(res, 'content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        })
      }
      for (const delta of sent) {
        if (delayMs > 0) await pause()
        if (gone()) return
        answer.deltas.push(delta)
        if (wire === 'anthropic') {
          sse(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: delta },
          })
        } else {
          chunk({ content: delta })
        }
      }
      if (now === 'stream-break') {
        // Let the deltas reach the client, then end the connection with no end of stream.
        await new Promise((resolve) => setTimeout(resolve, 50))
        destroyedHere = true
        res.socket?.destroy()
        return
      }
      if (now === 'stream-stall') return
      if (now === 'stream-error') {
        const message = echoMessage(key, lastUser)
        if (wire === 'anthropic') {
          sse(res, 'error', { type: 'error', error: { type: 'overloaded_error', message } })
        } else {
          sse(res, undefined, {
            error: { message, type: 'server_error', param: null, code: null },
          })
        }
        res.end()
        return
      }
      if (wire === 'anthropic') {
        if (sent.length > 0)
          sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
        calls.forEach((call, i) => {
          const index = (sent.length > 0 ? 1 : 0) + i
          sse(res, 'content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
          })
          for (const piece of piecesOf(JSON.stringify(argsInput(call)))) {
            sse(res, 'content_block_delta', {
              type: 'content_block_delta',
              index,
              delta: { type: 'input_json_delta', partial_json: piece },
            })
          }
          sse(res, 'content_block_stop', { type: 'content_block_stop', index })
        })
        sse(res, 'message_delta', {
          type: 'message_delta',
          delta: { stop_reason: wireStop, stop_sequence: null },
          usage: { output_tokens: outputWords },
        })
        sse(res, 'message_stop', { type: 'message_stop' })
      } else {
        calls.forEach((call, index) => {
          chunk({
            tool_calls: [
              {
                index,
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: '' },
              },
            ],
          })
          for (const piece of piecesOf(argsText(call))) {
            chunk({ tool_calls: [{ index, function: { arguments: piece } }] })
          }
        })
        chunk({}, wireStop)
        if (c.includeUsage) {
          sse(res, undefined, {
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [],
            usage: {
              prompt_tokens: answered.inputWords,
              completion_tokens: outputWords,
              total_tokens: answered.inputWords + outputWords,
            },
          })
        }
        sse(res, undefined, '[DONE]')
      }
      res.end()
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

/** A call as `chat()` answers it. */
export interface ToolCallOut {
  id: string
  name: string
  args: Record<string, unknown>
}

/** What `chat()` answers once it knows tools. */
export interface ToolAwareResult {
  text: string
  stopReason: string
  usage: { inputTokens: number; outputTokens: number }
  model: string
  toolCalls?: ToolCallOut[]
}

/** One event of `chatStream()`. */
export type ToolAwareEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCallOut }
  | { type: 'done'; result: ToolAwareResult }

/** An ai adapter's `chat()` and `chatStream()` with tool turns, typed apart from `@nymbalhq/types` on purpose. */
export interface ToolAwareAdapter {
  chat(messages: readonly unknown[], opts?: Record<string, unknown>): Promise<ToolAwareResult>
  chatStream?(
    messages: readonly unknown[],
    opts?: Record<string, unknown>,
  ): AsyncIterable<ToolAwareEvent>
}

/** The adapter as one that takes tool turns, so a test of them compiles whatever the published types say. */
export const toolAware = (adapter: object): ToolAwareAdapter =>
  adapter as unknown as ToolAwareAdapter

/** Eval E5's tool, as the wire tests send it. */
export const LOOKUP_PRICE = {
  name: 'lookup_price',
  description: 'The price of one product, by its SKU.',
  inputSchema: {
    type: 'object',
    properties: { sku: { type: 'string', description: 'The product SKU, e.g. B-4.' } },
    required: ['sku'],
    additionalProperties: false,
  },
} as const

/** The code a call rejected with, or `resolved`. */
export const settledCode = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => 'resolved',
    (error: unknown) => (error as { code?: unknown } | null)?.code,
  )
