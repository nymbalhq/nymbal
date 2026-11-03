import { defineCommand } from 'citty'
import {
  Client,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client'
import { Server, type CallToolResult, type Tool } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { CSRF_COOKIE, CSRF_HEADER, MCP_PATH } from '@nymbalhq/http'
import { loadProject } from '../utils/project.js'
import { getCliVersion } from '../utils/version.js'

/** Signs in again this long before the access token lapses. */
const REFRESH_MARGIN_MS = 60_000

/** A refusal the bridge reports on stderr and exits on; stdout carries MCP messages only. */
class BridgeError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2,
  ) {
    super(message)
  }
}

interface Credential {
  /** The bearer to send now, signing in again when the last one is about to lapse; none for an anonymous agent. */
  bearer(): Promise<string | undefined>
}

async function signIn(
  endpoint: URL,
  email: string,
  password: string,
): Promise<{ token: string; expiresAt: number }> {
  const csrfRes = await fetch(new URL('/api/csrf', endpoint))
  const csrf = ((await csrfRes.json()) as { data?: { token?: string } }).data?.token
  if (!csrfRes.ok || csrf === undefined) {
    throw new BridgeError(`${endpoint.origin} gave no CSRF token (${csrfRes.status})`, 1)
  }
  const res = await fetch(new URL('/api/auth/login', endpoint), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `${CSRF_COOKIE}=${csrf}`,
      [CSRF_HEADER]: csrf,
    },
    body: JSON.stringify({ email, password }),
  })
  const body = (await res.json()) as {
    data?: { accessToken?: string; expiresIn?: number }
    error?: { message?: string }
  }
  if (!res.ok || body.data?.accessToken === undefined) {
    throw new BridgeError(
      `sign-in as ${email} at ${endpoint.origin} was refused (${res.status}): ${body.error?.message ?? 'no token'}`,
      1,
    )
  }
  return {
    token: body.data.accessToken,
    expiresAt: Date.now() + (body.data.expiresIn ?? 0) * 1000,
  }
}

function credentialFrom(
  endpoint: URL,
  token: string | undefined,
  env: NodeJS.ProcessEnv,
): Credential {
  if (token !== undefined) return { bearer: async () => token }
  const email = env['NYMBAL_MCP_EMAIL']
  const password = env['NYMBAL_MCP_PASSWORD']
  if (!email || !password) return { bearer: async () => undefined }
  let session: { token: string; expiresAt: number } | undefined
  return {
    async bearer() {
      if (session === undefined || Date.now() > session.expiresAt - REFRESH_MARGIN_MS) {
        session = await signIn(endpoint, email, password)
      }
      return session.token
    },
  }
}

async function endpointOf(url: string | undefined): Promise<URL> {
  const given = url ?? process.env['NYMBAL_MCP_URL']
  if (given !== undefined && given !== '') {
    try {
      return new URL(given)
    } catch {
      throw new BridgeError(`--url ${given} is not a URL`, 2)
    }
  }
  const { config } = await loadProject()
  return new URL(MCP_PATH, `http://localhost:${config.http.port}`)
}

/** A client of the store's endpoint that sends the credential's bearer on every request. */
async function connect(endpoint: URL, credential: Credential): Promise<Client> {
  const client = new Client({ name: 'nymbal-mcp', version: getCliVersion() })
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      const bearer = await credential.bearer()
      if (bearer !== undefined) headers.set('authorization', `Bearer ${bearer}`)
      return fetch(url, { ...init, headers })
    },
  })
  try {
    await credential.bearer()
    await client.connect(transport)
  } catch (error) {
    if (error instanceof BridgeError) throw error
    throw new BridgeError(refusalOf(endpoint, error), 1)
  }
  return client
}

/** What `connect` failed on: a store that answered and refused says why; only an unreachable one is "start it". */
function refusalOf(endpoint: URL, error: unknown): string {
  const at = `the store at ${endpoint.href}`
  const status =
    error instanceof UnauthorizedError
      ? 401
      : error instanceof SdkHttpError
        ? error.status
        : undefined
  if (status === 401) {
    return `${at} refused the bearer (401): set NYMBAL_MCP_TOKEN or NYMBAL_MCP_EMAIL and NYMBAL_MCP_PASSWORD`
  }
  if (status === 403) {
    return `${at} refused this client (403): its Origin is not in http.cors.allowedOrigins`
  }
  if (status === 429) {
    return `${at} is rate-limiting this client (429): wait, or raise security.rateLimit for ${endpoint.pathname}`
  }
  const reason = error instanceof Error ? error.message : String(error)
  if (status !== undefined) return `${at} refused the connection (${status}): ${reason}`
  return `no store answers at ${endpoint.href} (${reason}); start the store with nymbal dev`
}

async function listAll(client: Client): Promise<Tool[]> {
  const tools: Tool[] = []
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor })
    tools.push(...page.tools)
    cursor = page.nextCursor
  } while (cursor !== undefined)
  return tools
}

/** stdio in front of the store's `POST /api/mcp`: every listing and call is the store's own answer. */
function bridge(upstream: Client): void {
  serveStdio(() => {
    const server = new Server(
      { name: 'nymbal', version: getCliVersion() },
      { capabilities: { tools: {} } },
    )
    server.setRequestHandler('tools/list', async () => ({ tools: await listAll(upstream) }))
    server.setRequestHandler('tools/call', async (request) => {
      const result = (await upstream.callTool({
        name: request.params.name,
        arguments: request.params.arguments ?? {},
      })) as CallToolResult
      return server.projectCallToolResult(result, undefined)
    })
    return server
  })
}

const FLAGS = new Set(['url', 'token', 'json', 'help', 'h'])

export const mcpCommand = defineCommand({
  meta: {
    name: 'mcp',
    description:
      "Serve the store's agent tools on stdio, for an MCP host to launch (`nymbal mcp tools` lists them)",
  },
  args: {
    action: {
      type: 'positional',
      required: false,
      description: '`tools`: print the tool names the store lists for this credential',
    },
    url: {
      type: 'string',
      description:
        "The store's MCP endpoint (NYMBAL_MCP_URL; default http://localhost:<http.port>/api/mcp)",
    },
    token: {
      type: 'string',
      description:
        'A bearer the store signed (NYMBAL_MCP_TOKEN); or set NYMBAL_MCP_EMAIL and NYMBAL_MCP_PASSWORD',
    },
    json: { type: 'boolean', description: 'With `tools`: the names as one JSON array' },
  },
  async run({ args, rawArgs }) {
    try {
      const unknown = rawArgs
        .filter((arg) => arg.startsWith('-'))
        .map((arg) => arg.replace(/^-+/, '').split('=')[0]!)
        .filter((flag) => !FLAGS.has(flag))
      if (unknown.length > 0) throw new BridgeError(`unknown flag --${unknown[0]}`, 2)
      if (args.action !== undefined && args.action !== 'tools') {
        throw new BridgeError(`unknown action ${args.action}; the one action is tools`, 2)
      }
      const endpoint = await endpointOf(args.url)
      const token = args.token ?? process.env['NYMBAL_MCP_TOKEN']
      const upstream = await connect(
        endpoint,
        credentialFrom(endpoint, token === '' ? undefined : token, process.env),
      )
      if (args.action !== 'tools') {
        bridge(upstream)
        return
      }
      const names = (await listAll(upstream)).map((tool) => tool.name)
      await upstream.close()
      process.stdout.write(
        args.json ? `${JSON.stringify(names)}\n` : names.map((n) => `${n}\n`).join(''),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`nymbal mcp: ${message}\n`)
      process.exitCode = error instanceof BridgeError ? error.exitCode : 1
    }
  },
})
