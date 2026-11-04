// A server-sent events reader for a provider's streamed answer, the same in every ai provider package. It yields each
// event once its blank line has arrived; a read that fails (a broken connection, an abort) rejects as it is, for the
// adapter to classify.

/** One event: its `event` field (`message` when it has none) and its `data` lines joined by a newline. */
export interface SseEvent {
  event: string
  data: string
}

export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event = ''
  let data: string[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      let text = buffer + (done ? decoder.decode() : decoder.decode(value, { stream: true }))
      // A CR at the end is held back, as the LF that may make it one line end can be in the next chunk.
      const held = !done && text.endsWith('\r') ? '\r' : ''
      if (held !== '') text = text.slice(0, -1)
      const lines = text.split(/\r\n|\r|\n/)
      // The last piece is a line not yet ended.
      buffer = (lines.pop() ?? '') + held
      for (const line of lines) {
        if (line === '') {
          if (data.length > 0)
            yield { event: event === '' ? 'message' : event, data: data.join('\n') }
          event = ''
          data = []
          continue
        }
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        const raw = colon === -1 ? '' : line.slice(colon + 1)
        const value = raw.startsWith(' ') ? raw.slice(1) : raw
        if (field === 'event') event = value
        else if (field === 'data') data.push(value)
      }
      // An event whose blank line never came is incomplete, as the standard has it, and is dropped.
      if (done) return
    }
  } finally {
    reader.releaseLock()
  }
}
