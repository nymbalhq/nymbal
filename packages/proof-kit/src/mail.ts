export interface MailMessage {
  id: string
  from: string
  to: string[]
  subject: string
  text: string
}

export interface MailSink {
  /** The `smtp` email provider's config that sends to this sink. */
  emailConfig(): { smtp: { host: string; port: number; secure: false } }
  messages(filter: { to: string }): Promise<MailMessage[]>
  waitFor(
    filter: { to: string; count?: number },
    opts?: { timeoutMs?: number },
  ): Promise<MailMessage[]>
}

interface MailpitAddress {
  Address: string
}

interface MailpitSummary {
  ID: string
  To: MailpitAddress[] | null
}

interface MailpitMessage {
  ID: string
  From: MailpitAddress | null
  To: MailpitAddress[] | null
  Subject: string
  Text: string
}

const POLL_MS = 100

async function getJson<T>(url: URL): Promise<T> {
  const res = await fetch(url)
  if (!res.ok)
    throw new Error(`Mailpit ${url.pathname} answered ${res.status}: ${await res.text()}`)
  return (await res.json()) as T
}

/** A Mailpit server (compose.yaml, or the CI service) that the `smtp` email provider delivers to. */
export function createMailSink(opts: { apiUrl?: string; smtp?: string } = {}): MailSink {
  const apiUrl = opts.apiUrl ?? process.env.NYMBAL_TEST_MAILPIT_URL ?? 'http://localhost:18025'
  const smtp = opts.smtp ?? process.env.NYMBAL_TEST_MAILPIT_SMTP ?? 'localhost:11025'
  const at = smtp.lastIndexOf(':')
  const host = smtp.slice(0, at)
  const port = Number(smtp.slice(at + 1))
  if (at < 1 || !Number.isInteger(port)) {
    throw new Error(`createMailSink: smtp must be host:port, got "${smtp}"`)
  }

  // Mailpit's to:"…" matches a substring (a@x finds ba@x), so the summaries are narrowed to the exact address. Mailpit
  // itself compares without case, and so does this.
  async function summaries(to: string): Promise<MailpitSummary[]> {
    const search = new URL('/api/v1/search', apiUrl)
    search.searchParams.set('query', `to:"${to}"`)
    search.searchParams.set('limit', '500')
    const { messages: found } = await getJson<{ messages: MailpitSummary[] }>(search)
    const wanted = to.toLowerCase()
    return found.filter((m) => (m.To ?? []).some((a) => a.Address.toLowerCase() === wanted))
  }

  function bodies(found: MailpitSummary[]): Promise<MailMessage[]> {
    return Promise.all(
      found.map(async ({ ID }) => {
        const m = await getJson<MailpitMessage>(new URL(`/api/v1/message/${ID}`, apiUrl))
        return {
          id: m.ID,
          from: m.From?.Address ?? '',
          to: (m.To ?? []).map((a) => a.Address),
          subject: m.Subject,
          text: m.Text,
        }
      }),
    )
  }

  return {
    emailConfig: () => ({ smtp: { host, port, secure: false } }),
    messages: async (filter) => bodies(await summaries(filter.to)),
    async waitFor(filter, waitOpts = {}) {
      const count = filter.count ?? 1
      const timeoutMs = waitOpts.timeoutMs ?? 10_000
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = await summaries(filter.to)
        if (found.length >= count) return bodies(found)
        if (Date.now() >= deadline) {
          throw new Error(
            `waitFor: expected ${count} message(s) to ${filter.to} within ${timeoutMs}ms, saw ${found.length}`,
          )
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      }
    },
  }
}
