import type {
  AiAdapter,
  ChatMessage,
  ChatOptions,
  ChatResult,
  ChatStreamEvent,
  ChatToolCall,
} from '@nymbalhq/types'

// An ai adapter in-process, for a test that runs the assistant's loop itself: each request is answered by `script`
// from the conversation the loop sent, and every request is kept as it was sent (the conversation copied at the call,
// the system prompt and the names of the tools offered). It validates nothing, so a call whose name no provider would
// accept reaches the loop as the model asked for it. Call ids are unique per adapter.

export interface ScriptedRequest {
  index: number
  messages: ChatMessage[]
  system: string
  tools: string[]
}

export interface ScriptedReply {
  text?: string
  calls?: Array<{ name: string; args: Record<string, unknown> }>
}

export interface ScriptedAi {
  ai: AiAdapter
  requests: ScriptedRequest[]
}

export function scriptedAi(script: (request: ScriptedRequest) => ScriptedReply): ScriptedAi {
  const requests: ScriptedRequest[] = []
  let ids = 0
  const usage = { inputTokens: 1, outputTokens: 1 }
  const answer = (messages: readonly ChatMessage[], opts?: ChatOptions): ChatResult => {
    const request: ScriptedRequest = {
      index: requests.length,
      messages: messages.map((m) => ({ ...m })),
      system: opts?.system ?? '',
      tools: (opts?.tools ?? []).map((t) => t.name),
    }
    requests.push(request)
    const reply = script(request)
    const toolCalls: ChatToolCall[] = (reply.calls ?? []).map((c) => ({
      id: `call_${(ids += 1)}`,
      name: c.name,
      args: c.args,
    }))
    return {
      text: reply.text ?? '',
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end',
      usage,
      model: 'scripted',
      toolCalls,
    }
  }
  const ai = {
    kind: 'ai',
    providerName: 'scripted',
    capabilities: () => ['complete', 'chat', 'tools', 'stream'],
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
    async chat(messages: readonly ChatMessage[], opts?: ChatOptions) {
      return answer(messages, opts)
    },
    async *chatStream(
      messages: readonly ChatMessage[],
      opts?: ChatOptions,
    ): AsyncIterable<ChatStreamEvent> {
      const result = answer(messages, opts)
      if (result.text !== '') yield { type: 'text', delta: result.text }
      for (const call of result.toolCalls) yield { type: 'tool_call', call }
      yield { type: 'done', result }
    },
  } as unknown as AiAdapter
  return { ai, requests }
}

/** The tool turns that answer the calls of request `index - 1`: the trailing `tool` messages of request `index`. */
export function toolMessagesOf(
  request: ScriptedRequest,
): Array<Extract<ChatMessage, { role: 'tool' }>> {
  const out: Array<Extract<ChatMessage, { role: 'tool' }>> = []
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const m = request.messages[i]!
    if (m.role !== 'tool') break
    out.unshift(m)
  }
  return out
}
