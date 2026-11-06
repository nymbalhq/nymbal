import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

// AC-8 and AC-9, run by scripts/quickstart.sh <astro|nextjs> in the `quickstart` project once it has followed the
// quickstart page: the store's image runs `nymbal start` in a container with the scaffold's default config (no
// `agents` block, so an agent's admin write is a proposal). An agent connects through the scaffold's own `nymbal mcp`,
// signed in as the admin `.env` holds. Then no crash: the container never restarted, nothing answered 5xx, nothing
// logged at fatal, and a stop ends it with exit code 0. The last test stops the container.
//
//   NYMBAL_SCAFFOLD_DIR  the scaffolded project
//   NYMBAL_STORE_URL     the container's published port, http://localhost:8080
//   NYMBAL_CONTAINER     the running container

const DIR = process.env['NYMBAL_SCAFFOLD_DIR']
const STORE_URL = process.env['NYMBAL_STORE_URL']
const CONTAINER = process.env['NYMBAL_CONTAINER']
if (!DIR || !STORE_URL || !CONTAINER) {
  throw new Error(
    'The quickstart proof needs NYMBAL_SCAFFOLD_DIR, NYMBAL_STORE_URL and NYMBAL_CONTAINER. Run it through ' +
      'scripts/quickstart.sh <astro|nextjs>, which follows the quickstart page and sets them.',
  )
}
const SCAFFOLD: string = DIR
const STORE: string = STORE_URL
const NAME: string = CONTAINER
/** Where quickstart.sh reads what crashed, beside the scaffold. */
const CRASH_FILE = join(SCAFFOLD, '..', 'quickstart-crash')

const AGENT = { name: 'quickstart-agent', version: '1.0.0' }
const FATAL = 60

/** Every HTTP status this run received from the store, by request. */
const received: Array<{ what: string; status: number }> = []

function dotEnv(name: string): string {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`, 'm').exec(
    readFileSync(join(SCAFFOLD, '.env'), 'utf8'),
  )
  const value = match?.[1]?.replace(/^(['"])(.*)\1$/, '$2')
  if (value === undefined) throw new Error(`${name} is not in ${SCAFFOLD}/.env`)
  return value
}

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

async function get<T>(path: string, token?: string): Promise<T> {
  const res = await fetch(new URL(path, STORE), {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  })
  received.push({ what: `GET ${path}`, status: res.status })
  const body = (await res.json()) as { data?: T }
  if (res.status !== 200 || body.data === undefined) {
    throw new Error(`GET ${path}: ${res.status} ${JSON.stringify(body)}`)
  }
  return body.data
}

/** An access token for the admin `.env` holds, signed in through the store's CSRF pair. */
async function adminToken(): Promise<string> {
  const csrf = randomBytes(32).toString('hex')
  const res = await fetch(new URL('/api/auth/login', STORE), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `nymbal.csrf=${csrf}`,
      'x-csrf-token': csrf,
    },
    body: JSON.stringify({
      email: dotEnv('NYMBAL_ADMIN_EMAIL'),
      password: dotEnv('NYMBAL_ADMIN_PASSWORD'),
    }),
  })
  received.push({ what: 'POST /api/auth/login', status: res.status })
  const body = (await res.json()) as { data?: { accessToken?: string } }
  if (res.status !== 200 || body.data?.accessToken === undefined) {
    throw new Error(`admin login: ${res.status} ${JSON.stringify(body)}`)
  }
  return body.data.accessToken
}

/** The storefront's published catalogue, every page of it, by slug. */
async function catalogue(): Promise<string[]> {
  const slugs: string[] = []
  let cursor: string | null | undefined
  do {
    const page = await get<{ items: Array<{ slug: string }>; nextCursor?: string | null }>(
      `/api/products?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    )
    slugs.push(...page.items.map((p) => p.slug))
    cursor = page.nextCursor
  } while (cursor)
  return slugs
}

/** Every product the admin sees, drafts included. */
async function adminProductCount(token: string): Promise<number> {
  let count = 0
  for (let offset = 0; ; offset += 200) {
    const page = await get<unknown[]>(`/api/admin/products?limit=200&offset=${offset}`, token)
    count += page.length
    if (page.length < 200) return count
  }
}

interface ProposalView {
  id: string
  tool: string
  args: Record<string, unknown>
  status: string
  proposer: { agent: { name: string } }
}

const pendingProposals = (token: string) =>
  get<{ items: ProposalView[]; pending: number }>(
    '/api/admin/proposals?status=pending&limit=200',
    token,
  )

type Structured = Record<string, unknown>

/** What the store's agent tools answer, through the scaffold's own bridge. */
async function connectAgent(): Promise<Client> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].startsWith('npm_') && !entry[0].startsWith('VITEST'),
    ),
  )
  const client = new Client(AGENT)
  await client.connect(
    new StdioClientTransport({
      command: join(SCAFFOLD, 'node_modules', '.bin', 'nymbal'),
      args: ['mcp'],
      cwd: SCAFFOLD,
      env: {
        ...env,
        NYMBAL_MCP_URL: new URL('/api/mcp', STORE).href,
        NYMBAL_MCP_EMAIL: dotEnv('NYMBAL_ADMIN_EMAIL'),
        NYMBAL_MCP_PASSWORD: dotEnv('NYMBAL_ADMIN_PASSWORD'),
      },
      stderr: 'pipe',
    }),
  )
  return client
}

async function call(client: Client, name: string, args: Structured): Promise<Structured> {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError === true) throw new Error(`${name}: ${JSON.stringify(result.content)}`)
  return (result.structuredContent ?? {}) as Structured
}

let client: Client | undefined
afterAll(async () => {
  await client?.close()
})

describe('AC-8: an agent calls the deployed store over MCP, and its admin write waits as a proposal', () => {
  it("AC-8: through the scaffold's nymbal mcp, products_list holds every product GET /api/products lists; admin_products_create answers proposed; the inbox holds one more pending proposal with that input and the agent's name; the admin's product count is unchanged", async () => {
    const token = await adminToken()
    const listed = await catalogue()
    const pendingBefore = (await pendingProposals(token)).pending
    const adminBefore = await adminProductCount(token)

    client = await connectAgent()
    const seen: string[] = []
    let cursor: unknown
    do {
      const page = await call(client, 'products_list', {
        limit: '100',
        ...(typeof cursor === 'string' && { cursor }),
      })
      seen.push(...((page['items'] ?? []) as Array<{ slug: string }>).map((p) => p.slug))
      cursor = page['nextCursor']
    } while (typeof cursor === 'string' && cursor !== '')

    const tag = randomBytes(6).toString('hex')
    const input = {
      slug: `quickstart-${tag}`,
      name: `Quickstart ${tag}`,
      variants: [{ sku: `QS-${tag}`, name: 'Default', priceMinor: 1500, stock: 3, options: [] }],
    }
    const answer = await call(client, 'admin_products_create', input)
    const after = await pendingProposals(token)
    const mine = after.items.filter((p) => p.args['slug'] === input.slug)
    const adminAfter = await adminProductCount(token)

    expect(listed.length).toBeGreaterThan(0)
    expect([...seen].sort()).toEqual([...listed].sort())
    expect(answer['status']).toBe('proposed')
    expect(after.pending).toBe(pendingBefore + 1)
    expect(mine.map((p) => ({ tool: p.tool, args: p.args, agent: p.proposer.agent.name }))).toEqual(
      [{ tool: 'admin_products_create', args: expect.objectContaining(input), agent: AGENT.name }],
    )
    expect(adminAfter).toBe(adminBefore)
  }, 120_000)
})

describe('AC-9: no crash in the run', () => {
  it('AC-9: the container is running with no restart, no response was 5xx, its log has no fatal line, and docker stop -t 15 ends it with exit code 0', async () => {
    await client?.close()
    client = undefined
    const running = docker(['inspect', '-f', '{{.State.Running}}', NAME]).trim() === 'true'
    const restarts = Number(docker(['inspect', '-f', '{{.RestartCount}}', NAME]).trim())
    const fatal = docker(['logs', NAME])
      .split('\n')
      .flatMap((line) => {
        try {
          const entry = JSON.parse(line) as { level?: number; msg?: string }
          return typeof entry.level === 'number' && entry.level >= FATAL ? [entry.msg ?? line] : []
        } catch {
          return []
        }
      })
    const serverErrors = received.filter((r) => r.status >= 500)
    execFileSync('docker', ['stop', '-t', '15', NAME])
    const exitCode = Number(docker(['inspect', '-f', '{{.State.ExitCode}}', NAME]).trim())

    const crashes = [
      ...(running ? [] : ['the container was not running']),
      ...(restarts === 0 ? [] : [`the container restarted ${restarts} times`]),
      ...serverErrors.map((r) => `${r.what} answered ${r.status}`),
      ...fatal.map((msg) => `fatal log line: ${msg}`),
      ...(exitCode === 0 ? [] : [`docker stop ended it with exit code ${exitCode}`]),
    ]
    writeFileSync(CRASH_FILE, crashes.map((c) => `${c}\n`).join(''))

    expect(received.length).toBeGreaterThan(0)
    expect(crashes).toEqual([])
  }, 60_000)
})
