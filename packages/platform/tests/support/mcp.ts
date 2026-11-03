import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import Database from 'better-sqlite3'
import type { Caller, ToolDefinition, ToolResult } from '@nymbalhq/types'
import type { NymbalApp } from '../../src/app.js'
import type { Proposal, ProposalSink } from '../../src/mcp/proposals.js'
import type { Kernel } from './kernel.js'
import { shopper } from './shopper.js'
import { unaudited } from './write-audit.js'

// The agent side of the tool registry: callers as the transports hand them to the invoker (a verified bearer, or none),
// the accounts behind them, and a proposal sink that keeps what it was given. Nothing here knows how the registry, the
// invoker or the transports are built.

export const AGENT = { name: 'acceptance-agent', version: '1.0.0' } as const

/** No bearer: what a transport passes when the request carried none. */
export const ANONYMOUS: Caller = { agent: AGENT }

/** The in-process tool surface `attachHttp` builds on the app. */
export interface ToolSurface {
  list(caller: Caller): ToolDefinition[] | Promise<ToolDefinition[]>
  call(name: string, args: unknown, caller: Caller): Promise<ToolResult>
}

/** The app's tool surface; it exists once `attachHttp` has run. */
export function toolSurface(app: NymbalApp): ToolSurface {
  const surface = (app as { mcp?: ToolSurface }).mcp
  if (surface === undefined)
    throw new Error('NymbalApp.mcp is missing: attachHttp builds no tool surface')
  return surface
}

/** The names a listing holds, in its order. */
export async function listedNames(surface: ToolSurface, caller: Caller): Promise<string[]> {
  return (await Promise.resolve(surface.list(caller))).map((tool) => tool.name)
}

export interface Account {
  userId: string
  email: string
  password: string
  /** An access token the store signed for this account. */
  token: string
  /** The caller a transport makes of that token once it verifies; the token rides along to prove it never leaks. */
  caller: Caller
}

async function callerOf(kernel: Kernel, token: string): Promise<Caller> {
  const payload = await kernel.services.auth.verifyAccessToken(token)
  return { auth: { userId: payload.sub, roles: payload.roles, token }, agent: AGENT }
}

async function signIn(baseUrl: string, email: string, password: string): Promise<string> {
  const shop = shopper(baseUrl)
  const res = await shop.call<{ accessToken: string }>('POST', '/api/auth/login', {
    email,
    password,
  })
  if (res.status !== 200)
    throw new Error(`login ${email}: ${res.status} ${JSON.stringify(res.body)}`)
  return res.body.data!.accessToken
}

/** An admin account of its own (roles ['admin']), signed in over HTTP. */
export async function adminAccount(kernel: Kernel, baseUrl: string): Promise<Account> {
  const userId = randomUUID()
  const email = `admin-${userId}@mcp.test`
  const password = 'mcp-correct-horse-battery'
  const now = new Date()
  await unaudited(() =>
    kernel.store.transaction((tx) =>
      kernel.repos.customer.insert(tx, {
        id: userId,
        email,
        passwordHash: bcrypt.hashSync(password, 4),
        roles: ['admin'],
        requiresPasswordReset: false,
        createdAt: now,
        updatedAt: now,
      }),
    ),
  )
  const token = await signIn(baseUrl, email, password)
  return { userId, email, password, token, caller: await callerOf(kernel, token) }
}

/** A customer registered over HTTP. */
export async function customerAccount(kernel: Kernel, baseUrl: string): Promise<Account> {
  const shop = shopper(baseUrl)
  const email = `customer-${randomUUID()}@mcp.test`
  const password = 'mcp-customer-horse'
  const res = await shop.call<{ customer: { id: string }; accessToken: string }>(
    'POST',
    '/api/auth/register',
    { email, password },
  )
  if (res.status !== 201) throw new Error(`register: ${res.status} ${JSON.stringify(res.body)}`)
  const token = res.body.data!.accessToken
  return {
    userId: res.body.data!.customer.id,
    email,
    password,
    token,
    caller: await callerOf(kernel, token),
  }
}

/** Committed rows of the kernel's SQLite file, read on a fresh read-only connection per query. */
export function committedRows<T>(file: string, sql: string, params: unknown[] = []): T[] {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    return db.prepare(sql).all(...params) as T[]
  } finally {
    db.close()
  }
}

export function committedCount(
  file: string,
  table: string,
  where?: string,
  params: unknown[] = [],
): number {
  const [row] = committedRows<{ n: number }>(
    file,
    `SELECT count(*) AS n FROM ${table}${where === undefined ? '' : ` WHERE ${where}`}`,
    params,
  )
  return row!.n
}

export function committedStock(file: string, variantId: string): number {
  const [row] = committedRows<{ stock: number }>(file, 'SELECT stock FROM variants WHERE id = ?', [
    variantId,
  ])
  if (row === undefined) throw new Error(`no variant ${variantId}`)
  return row.stock
}

export interface AuditEntry {
  command: string
  actorKind: string
  actorId: string
  subjectIds: string[]
  outcome: string
}

/** `audit_entries` as committed, oldest first, optionally only those one idempotency key wrote. */
export function committedAudit(file: string, idempotencyKey?: string): AuditEntry[] {
  const rows = committedRows<{
    command: string
    actor_kind: string
    actor_id: string
    subjects: string
    outcome: string
  }>(
    file,
    `SELECT command, actor_kind, actor_id, subjects, outcome FROM audit_entries${
      idempotencyKey === undefined ? '' : ' WHERE idempotency_key = ?'
    } ORDER BY at, id`,
    idempotencyKey === undefined ? [] : [idempotencyKey],
  )
  return rows.map((r) => ({
    command: r.command,
    actorKind: r.actor_kind,
    actorId: r.actor_id,
    subjectIds: (JSON.parse(r.subjects) as Array<{ id: string }>).map((s) => s.id),
    outcome: r.outcome,
  }))
}

/** A sink that keeps every proposal and answers ids `proposal-1`, `proposal-2`, … in order. */
export function recordingSink(): { sink: ProposalSink; proposals: Proposal[] } {
  const proposals: Proposal[] = []
  return {
    proposals,
    sink: {
      async propose(p: Proposal) {
        proposals.push(p)
        return { id: `proposal-${proposals.length}` }
      },
    },
  }
}

/** A tool result's `structuredContent` as a record, and its one text block parsed. */
export function contentOf(result: ToolResult): {
  structured: Record<string, unknown>
  text: unknown
} {
  const block = result.content[0]
  return {
    structured: (result.structuredContent ?? {}) as Record<string, unknown>,
    text: block === undefined ? undefined : (JSON.parse(block.text) as unknown),
  }
}

/** The cart handle a result carries in its structured content, when its route set the cart cookie. */
export function cartHandleOf(result: ToolResult): string | undefined {
  const handle = (result.structuredContent as { cartHandle?: unknown } | undefined)?.cartHandle
  return typeof handle === 'string' ? handle : undefined
}

/** Every string a result carries, text block and structured content alike, for a leak search. */
export function resultText(result: ToolResult): string {
  return JSON.stringify(result)
}

/** A product body `POST /api/admin/products` accepts: one active variant at `stock`, unique slug and sku. */
export function productBody(stock = 5): {
  slug: string
  name: string
  status: 'active'
  variants: Array<{
    sku: string
    name: string
    priceMinor: number
    stock: number
    options: never[]
  }>
} {
  const tag = randomUUID()
  return {
    slug: `mcp-${tag}`,
    name: `MCP Widget ${tag.slice(0, 8)}`,
    status: 'active',
    variants: [{ sku: `MCP-${tag}`, name: 'Default', priceMinor: 1500, stock, options: [] }],
  }
}
