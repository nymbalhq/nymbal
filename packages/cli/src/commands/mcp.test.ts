import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import {
  CLI_BIN,
  cliEnv,
  closedPort,
  runCli,
  startDev,
  type DevRun,
} from '../../../../tests/support/doctor.js'
import { storeConfig, storeProject, type StoreProject } from '../../../../tests/support/start.js'
import { shopper } from '../../../platform/tests/support/shopper.js'

// AC-10: `nymbal mcp`, the stdio bridge to a running store's `POST /api/mcp`. The store is `nymbal dev --api-only`
// on a project of its own with `agents.mcp.writes: 'apply'`, whose first run seeds the admin named here; the bridge
// and `nymbal mcp tools` are spawned from the built CLI (`pnpm build` first). AC-7: what the bridge answers an admin is
// what the endpoint answers, customer contact details withheld (the store's default agents.mcp.withhold).

const ADMIN = { email: `admin-${randomUUID()}@mcp.test`, password: 'mcp-bridge-correct-horse' }
const AGENT = { name: 'bridge-acceptance', version: '1.0.0' }

let project: StoreProject | undefined
let dir = ''
let dev: DevRun
let endpoint = ''
let adminToken = ''

beforeAll(async () => {
  const config = storeConfig()
  // Each bridge signs in; the built-in login rule (10 in 15 minutes) would refuse a file of them.
  config['security'] = {
    ...(config['security'] as Record<string, unknown>),
    rateLimit: { '/api/auth/login': { requests: 1000, window: '1m', action: 'block' } },
  }
  project = storeProject({ ...config, agents: { mcp: { writes: 'apply' } } })
  dir = project.dir
  dev = await startDev([], {
    cwd: dir,
    env: cliEnv({
      NYMBAL_SQLITE_PATH: join(dir, 'nymbal.db'),
      NYMBAL_ADMIN_EMAIL: ADMIN.email,
      NYMBAL_ADMIN_PASSWORD: ADMIN.password,
    }),
  })
  endpoint = `${dev.base}/api/mcp`
  const shop = shopper(dev.base)
  const login = await shop.call<{ accessToken: string }>('POST', '/api/auth/login', ADMIN)
  if (login.status !== 200)
    throw new Error(`admin login: ${login.status} ${JSON.stringify(login.body)}`)
  adminToken = login.body.data!.accessToken
}, 120_000)

afterAll(async () => {
  await dev?.stop()
  project?.remove()
})

/** The bridge's environment: the endpoint, `extra`, and nothing of the shell's credentials. */
function bridgeEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env = cliEnv({
    NYMBAL_MCP_URL: endpoint,
    NYMBAL_MCP_TOKEN: undefined,
    NYMBAL_MCP_EMAIL: undefined,
    NYMBAL_MCP_PASSWORD: undefined,
    ...extra,
  })
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

const signedIn = () => ({ NYMBAL_MCP_EMAIL: ADMIN.email, NYMBAL_MCP_PASSWORD: ADMIN.password })

async function names(client: Client): Promise<string[]> {
  const all: string[] = []
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor })
    all.push(...page.tools.map((tool: { name: string }) => tool.name))
    cursor = page.nextCursor
  } while (cursor !== undefined)
  return all
}

async function withClient<T>(
  transport: StdioClientTransport | StreamableHTTPClientTransport,
  use: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client(AGENT)
  await client.connect(transport)
  try {
    return await use(client)
  } finally {
    await client.close()
  }
}

function overBridge<T>(env: Record<string, string>, use: (client: Client) => Promise<T>) {
  return withClient(
    new StdioClientTransport({
      command: process.execPath,
      args: [CLI_BIN, 'mcp'],
      cwd: dir,
      env,
      stderr: 'pipe',
    }),
    use,
  )
}

function overHttp<T>(token: string | undefined, use: (client: Client) => Promise<T>) {
  return withClient(
    new StreamableHTTPClientTransport(new URL(endpoint), {
      ...(token !== undefined && {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    }),
    use,
  )
}

describe('AC-10: nymbal mcp, the stdio bridge', () => {
  it('AC-10: the bridge lists what POST /api/mcp lists for the same credential: an admin by NYMBAL_MCP_EMAIL and NYMBAL_MCP_PASSWORD or NYMBAL_MCP_TOKEN, the public tools with nothing set; and login keeps its CSRF guard', async () => {
    const http = {
      admin: await overHttp(adminToken, names),
      anonymous: await overHttp(undefined, names),
    }
    const bridged = {
      password: await overBridge(bridgeEnv(signedIn()), names),
      token: await overBridge(bridgeEnv({ NYMBAL_MCP_TOKEN: adminToken }), names),
      anonymous: await overBridge(bridgeEnv(), names),
    }
    const bareLogin = await fetch(`${dev.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ADMIN),
    })
    await bareLogin.arrayBuffer()

    expect(bridged.password.sort()).toEqual([...http.admin].sort())
    expect(bridged.token.sort()).toEqual([...http.admin].sort())
    expect(bridged.anonymous.sort()).toEqual([...http.anonymous].sort())
    expect(http.admin).toEqual(expect.arrayContaining(http.anonymous))
    expect(http.admin.length).toBeGreaterThan(http.anonymous.length)
    expect(bareLogin.status).toBe(403)
  }, 90_000)

  it('AC-10: a tools/call through the bridge reaches the store: the product admin_products_create makes under apply is then served by GET /api/admin/products/:id', async () => {
    const slug = `bridge-${randomUUID()}`
    const result: { isError?: boolean | undefined; structuredContent?: unknown } = await overBridge(
      bridgeEnv(signedIn()),
      (client) =>
        client.callTool({
          name: 'admin_products_create',
          arguments: {
            slug,
            name: 'Bridged Widget',
            variants: [{ sku: slug, name: 'Default', priceMinor: 900, stock: 4, options: [] }],
          },
        }),
    )
    const res = await fetch(`${dev.base}/api/admin/products/${slug}`, {
      headers: { authorization: `Bearer ${adminToken}` },
    })
    const served = (await res.json()) as { data?: { slug?: string; id?: string } }

    expect(result.isError ?? false).toBe(false)
    expect(res.status).toBe(200)
    expect(served.data?.slug).toBe(slug)
    expect((result.structuredContent as { id?: string } | undefined)?.id).toBe(served.data?.id)
  }, 60_000)

  it("AC-10: a call through the bridge is recorded as the MCP host's agent, by its name and version, not the bridge's", async () => {
    const slug = `bridge-agent-${randomUUID()}`
    await overBridge(bridgeEnv(signedIn()), (client) =>
      client.callTool({
        name: 'admin_products_create',
        arguments: {
          slug,
          name: 'Attributed Widget',
          variants: [{ sku: slug, name: 'Default', priceMinor: 900, stock: 1, options: [] }],
        },
      }),
    )
    const res = await fetch(`${dev.base}/api/admin/proposals?status=all&limit=200`, {
      headers: { authorization: `Bearer ${adminToken}` },
    })
    const page = (await res.json()) as {
      data?: { items: Array<{ args: { slug?: string }; proposer: { agent: unknown } }> }
    }
    const recorded = (page.data?.items ?? []).filter((p) => p.args.slug === slug)

    expect(res.status).toBe(200)
    expect(recorded.map((p) => p.proposer.agent)).toEqual([AGENT])
  }, 60_000)

  it('AC-10: every line the bridge writes to stdout, at debug log level, through sign-in, initialize and tools/list, is a JSON-RPC 2.0 message', async () => {
    const child = spawn(process.execPath, [CLI_BIN, 'mcp'], {
      cwd: dir,
      env: bridgeEnv({ ...signedIn(), LOG_LEVEL: 'debug' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString()))
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString()))
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
    const answered = (id: number) =>
      vi.waitFor(
        () => {
          if (!stdout.split('\n').some((line) => line.includes(`"id":${id}`)))
            throw new Error(`no answer to ${id} yet; stderr:\n${stderr.slice(-2000)}`)
        },
        { timeout: 30_000, interval: 100 },
      )
    try {
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: AGENT },
      })
      await answered(1)
      send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      await answered(2)
    } finally {
      child.kill('SIGKILL')
    }
    const lines = stdout.split('\n').filter((line) => line.trim() !== '')
    const notJsonRpc = lines.filter((line) => {
      try {
        return (JSON.parse(line) as { jsonrpc?: unknown }).jsonrpc !== '2.0'
      } catch {
        return true
      }
    })
    const listed = lines
      .map((line) => JSON.parse(line) as { id?: number; result?: { tools?: unknown[] } })
      .find((message) => message.id === 2)

    expect(notJsonRpc).toEqual([])
    expect(listed?.result?.tools?.length).toBe((await overHttp(adminToken, names)).length)
  }, 90_000)

  it('AC-10: with the store down, nymbal mcp exits 1, names the URL and nymbal dev on stderr, and writes nothing to stdout', async () => {
    const down = `http://127.0.0.1:${await closedPort()}/api/mcp`

    const run = await runCli(['mcp'], {
      cwd: dir,
      env: bridgeEnv({ NYMBAL_MCP_URL: down }),
      timeoutMs: 30_000,
    })

    expect(run.code, run.out).toBe(1)
    expect(run.stderr).toContain(down)
    expect(run.stderr).toContain('nymbal dev')
    expect(run.stdout).toBe('')
  }, 60_000)

  it('AC-10: with the store up and a bearer it does not verify, nymbal mcp exits 1 and says the store refused the bearer (401) and which variables set one, not that no store answers', async () => {
    const run = await runCli(['mcp'], {
      cwd: dir,
      env: bridgeEnv({ NYMBAL_MCP_TOKEN: 'not-a-signed-token' }),
      timeoutMs: 30_000,
    })

    expect(run.code, run.out).toBe(1)
    expect(run.stderr).toContain(endpoint)
    expect(run.stderr).toContain('refused the bearer (401)')
    expect(run.stderr).toContain('NYMBAL_MCP_TOKEN')
    expect(run.stderr).not.toContain('nymbal dev')
    expect(run.stdout).toBe('')
  }, 60_000)

  it("AC-10: nymbal mcp tools prints the endpoint's listing for the credential one name per line in its order, and --json the same names as one array", async () => {
    const listing = await overHttp(adminToken, names)

    const plain = await runCli(['mcp', 'tools'], { cwd: dir, env: bridgeEnv(signedIn()) })
    const json = await runCli(['mcp', 'tools', '--json'], { cwd: dir, env: bridgeEnv(signedIn()) })

    expect([plain.code, json.code], plain.out + json.out).toEqual([0, 0])
    expect(plain.stdout.split('\n').filter((line) => line !== '')).toEqual(listing)
    expect(JSON.parse(json.stdout) as unknown).toEqual(listing)
  }, 60_000)
})

describe('AC-7: nymbal mcp answers what POST /api/mcp answers, customer contact details withheld', () => {
  type Called = { isError?: boolean | undefined; structuredContent?: unknown; content?: unknown }

  const textOf = (result: Called): string =>
    ((result.content ?? []) as Array<{ type: string; text?: string }>)[0]?.text ?? ''

  /** An order an anonymous agent places through checkout_begin for a product the admin creates; its buyer's details. */
  async function agentOrder(): Promise<{ orderNumber: string; values: string[] }> {
    const tag = randomUUID()
    const slug = `withheld-${tag}`
    const buyer = {
      email: `agent-${tag}@mcp.test`,
      phone: `07700 9${String(parseInt(tag.slice(0, 5), 16) % 100_000).padStart(5, '0')}`,
      addressLine1: `${tag.slice(0, 8)} Protocol Street`,
      postalCode: 'E1 6AN',
    }
    const home = {
      firstName: 'Agent',
      lastName: 'Buyer',
      addressLine1: buyer.addressLine1,
      city: 'London',
      region: 'England',
      postalCode: buyer.postalCode,
      country: 'GB',
      phone: buyer.phone,
    }
    const created: Called = await overHttp(adminToken, (client) =>
      client.callTool({
        name: 'admin_products_create',
        arguments: {
          slug,
          name: 'Withheld Widget',
          status: 'active',
          variants: [{ sku: slug, name: 'Default', priceMinor: 900, stock: 4, options: [] }],
        },
      }),
    )
    const variantId = (created.structuredContent as { variants: Array<{ id: string }> })
      .variants[0]!.id
    const placed: Called = await overHttp(undefined, async (client) => {
      const cart = (
        (await client.callTool({ name: 'cart_get', arguments: {} })).structuredContent as {
          cartHandle: string
        }
      ).cartHandle
      await vi.waitFor(
        async () => {
          const added = await client.callTool({
            name: 'cart_addItem',
            arguments: { cart, variantId, qty: 1 },
          })
          if (added.isError === true)
            throw new Error(`cart_addItem: ${JSON.stringify(added.content)}`)
        },
        { timeout: 10_000, interval: 100 },
      )
      return client.callTool({
        name: 'checkout_begin',
        arguments: { cart, email: buyer.email, billingAddress: home, shippingAddress: home },
      })
    })
    const orderNumber = (placed.structuredContent as { orderNumber?: string } | undefined)
      ?.orderNumber
    if (placed.isError === true || orderNumber === undefined) {
      throw new Error(`checkout_begin: ${JSON.stringify(placed.content)}`)
    }
    return { orderNumber, values: Object.values(buyer) }
  }

  // Kills: the bridge reshaping or refetching a result, or reading a route the endpoint does not withhold.
  it('AC-7: a tools/call of admin_orders_get over the bridge, signed in as the admin, holds none of the order’s email, phone, street line and postcode, holds withheld, and its structuredContent equals the same call’s over POST /api/mcp, while GET /api/admin/orders/:orderNumber answers all four', async () => {
    const order = await agentOrder()
    const read = (client: Client): Promise<Called> =>
      client.callTool({ name: 'admin_orders_get', arguments: { orderNumber: order.orderNumber } })

    const bridged = await overBridge(bridgeEnv(signedIn()), read)
    const direct = await overHttp(adminToken, read)
    const res = await fetch(`${dev.base}/api/admin/orders/${order.orderNumber}`, {
      headers: { authorization: `Bearer ${adminToken}` },
    })
    const route = await res.text()
    const held = JSON.stringify(bridged.structuredContent) + textOf(bridged)

    expect([res.status, bridged.isError ?? false]).toEqual([200, false])
    expect(order.values.filter((value) => route.includes(value))).toEqual(order.values)
    expect(order.values.filter((value) => held.includes(value))).toEqual([])
    expect((bridged.structuredContent as { withheld?: unknown }).withheld).toEqual([
      'email',
      'phone',
      'address',
      'postcode',
    ])
    expect(bridged.structuredContent).toEqual(direct.structuredContent)
  }, 90_000)
})
