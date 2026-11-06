// An ai adapter as a third party ships one, plain JavaScript with no dependency. Its chat() is the stand-in's model
// (tests/support/ai-stand-in.ts) answered in the process, with no network: "Reply with exactly the word X" gives X, a
// question about the code word gives the word from an earlier user turn, "Count from 1 to N" counts, a system prompt
// asking for upper case is obeyed, and more words than maxTokens stop at maxTokens. Usage is counted in words.
//
// `createAdapter(options)` takes the `config` record of the store's slot that names this package. With
// `ignoreSystem: true` it drops the system prompt: the variant the published ai suite must refuse to certify.

export const slot = 'ai'
export const provider = 'acme'

const words = (text) => text.split(/\s+/).filter((w) => w !== '')

function answer(messages, system) {
  const users = messages.filter((m) => m.role === 'user')
  const last = users.at(-1)?.content ?? ''
  const exact = /Reply with exactly the word ([A-Za-z0-9_-]+)/.exec(last)
  const count = /Count from 1 to (\d+)/.exec(last)
  let text
  if (exact) text = exact[1]
  else if (/code word/i.test(last)) {
    const earlier = users
      .slice(0, -1)
      .map((m) => /The code word is ([A-Za-z0-9_-]+)/.exec(m.content)?.[1])
      .find((w) => w !== undefined)
    text = earlier ?? 'I do not know.'
  } else if (count) {
    text = Array.from({ length: Number(count[1]) }, (_, i) => String(i + 1)).join(' ')
  } else if (/hello/i.test(last)) text = 'Hello there.'
  else text = 'Noted.'
  if (/upper case/i.test(system)) text = text.toUpperCase()
  return text
}

export function createAdapter(options = {}) {
  const ignoreSystem = options.ignoreSystem === true
  async function chat(messages, opts = {}) {
    const system = ignoreSystem ? '' : (opts.system ?? '')
    const maxTokens = opts.maxTokens ?? 1024
    let text = answer(messages, system)
    let stopReason = 'end'
    if (words(text).length > maxTokens) {
      text = words(text).slice(0, maxTokens).join(' ')
      stopReason = 'max_tokens'
    }
    const inputTokens = [system, ...messages.map((m) => m.content)].reduce(
      (n, t) => n + words(t).length,
      0,
    )
    return {
      text,
      stopReason,
      usage: { inputTokens, outputTokens: words(text).length },
      model: 'acme-rules-1',
    }
  }
  return {
    kind: 'ai',
    providerName: 'acme',
    capabilities: () => ['complete', 'chat'],
    producesEvents: [],
    consumesEvents: [],
    async initialize() {},
    async healthCheck() {
      return { status: 'healthy' }
    },
    async embed() {
      throw new Error('embed is not supported')
    },
    chat,
    async complete(prompt, opts = {}) {
      return (await chat([{ role: 'user', content: prompt }], { maxTokens: opts.maxTokens })).text
    },
  }
}
