import { randomUUID } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import { API_URL } from './csrf'
import { expect } from './fixtures'

// An agent at the store's MCP endpoint (`POST /api/mcp`, JSON-RPC, signed in with an admin's bearer), and the
// admin's proposals API as a journey reads it. The agent names itself in each call's `_meta`, as an MCP client does.

export const AGENT = { name: 'e2e-inbox-agent', version: '1.0.0' } as const

const CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'

let rpcId = 0

/** One `tools/call` as the bearer's agent; its structured content and whether it is an error. */
export async function agentCall(
  request: APIRequestContext,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ structured: Record<string, unknown>; isError: boolean }> {
  rpcId += 1
  const res = await request.post(`${API_URL}/api/mcp`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    data: {
      jsonrpc: '2.0',
      id: rpcId,
      method: 'tools/call',
      params: { name, arguments: args, _meta: { [CLIENT_INFO]: AGENT } },
    },
  })
  const text = await res.text()
  expect(res.status(), `POST /api/mcp tools/call ${name}: ${text}`).toBe(200)
  // A Streamable HTTP answer is JSON or one SSE message whose data is the JSON-RPC response.
  const payload = (res.headers()['content-type'] ?? '').includes('text/event-stream')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.replace(/^data: ?/, ''))
        .join('\n')
    : text
  const message = JSON.parse(payload) as {
    result?: { structuredContent?: Record<string, unknown>; isError?: boolean }
    error?: unknown
  }
  expect(message.error, `tools/call ${name}: ${payload}`).toBeUndefined()
  return {
    structured: message.result?.structuredContent ?? {},
    isError: message.result?.isError ?? false,
  }
}

export interface ProposedProduct {
  id: string
  slug: string
  name: string
  args: Record<string, unknown>
}

/** An agent's `admin_products_create` of a product of its own; `description` lets a journey make one argument long. */
export async function proposeProduct(
  request: APIRequestContext,
  token: string,
  description = 'Proposed by an agent in a journey.',
): Promise<ProposedProduct> {
  const tag = randomUUID().slice(0, 8)
  const args = {
    slug: `inbox-${tag}`,
    name: `Inbox Proposal ${tag}`,
    description,
    status: 'active',
    variants: [{ sku: `INBOX-${tag}`, name: 'Default', priceMinor: 2400, stock: 3, options: [] }],
  }
  const answer = await agentCall(request, token, 'admin_products_create', args)
  expect(answer.structured['status'], JSON.stringify(answer.structured)).toBe('proposed')
  const id = answer.structured['id']
  expect(
    typeof id,
    `admin_products_create answered no proposal id: ${JSON.stringify(answer.structured)}`,
  ).toBe('string')
  return { id: id as string, slug: args.slug, name: args.name, args }
}

export interface ProposalRead {
  id: string
  command: string
  status: string
  correlationId: string
  decision?: { by: { kind: string; id?: string }; at: string; reason?: string }
  outcome?: { status: number; code?: string; message?: string }
}

export async function readProposal(
  request: APIRequestContext,
  token: string,
  id: string,
): Promise<ProposalRead> {
  const res = await request.get(`${API_URL}/api/admin/proposals/${id}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.status(), `GET /api/admin/proposals/${id}: ${await res.text()}`).toBe(200)
  return ((await res.json()) as { data: ProposalRead }).data
}

/** `ProposalPage.pending`: how many proposals wait for a decision. */
export async function pendingCount(request: APIRequestContext, token: string): Promise<number> {
  const res = await request.get(`${API_URL}/api/admin/proposals?status=pending&limit=1`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.status(), `GET /api/admin/proposals: ${await res.text()}`).toBe(200)
  return ((await res.json()) as { data: { pending: number } }).data.pending
}

/** The status `GET /api/admin/products/:id` answers for a slug: 404 while no such product exists. */
export async function productStatus(
  request: APIRequestContext,
  token: string,
  slug: string,
): Promise<number> {
  const res = await request.get(`${API_URL}/api/admin/products/${slug}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  return res.status()
}
