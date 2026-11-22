import { randomUUID } from 'node:crypto'
import {
  AdapterError,
  type AiAdapter,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
  type ChatStreamEvent,
  type ProductSnapshot,
} from '@nymbalhq/types'
import { contentRoleDeps, type ContentRoleDeps } from '../../src/roles/content.js'
import type { Kernel } from './kernel.js'
import { writeRaw, type RawReader } from './raw.js'

// What the content role's tests share: an in-process model whose every request is kept (its system prompt, the text of
// every turn, the tools offered, the token bound) and answered by a script, with the usage each answer reports; the
// role's deps over a kernel, read and written through its services and repositories as createApp would wire them;
// products made through the product service with a chosen age; and the proposals table as a second connection reads
// it. Nothing here knows how the role selects, prompts or checks.

export const PROPOSER = 'role:content'
export const AGENT = 'nymbal-content'
export const UPDATE_TOOL = 'admin_products_update'
export const ROLE_RULE = 'agents.roles.content'
export const SEO_FIELDS = ['seoTitle', 'seoDescription'] as const

/** One request the role sent, as the model read it. */
export interface ContentRequest {
  index: number
  system: string
  /** The system prompt and every turn's text, joined. */
  text: string
  tools: string[]
  maxTokens: number | undefined
}

export interface ContentReply {
  text?: string
  calls?: Array<{ name: string; args: Record<string, unknown> }>
  /** What the answer reports it used; 300 in and 60 out when not given. */
  usage?: { inputTokens: number; outputTokens: number }
  /** Answer as a provider failure (`AdapterError`). */
  fail?: boolean
}

export interface ContentAi {
  ai: AiAdapter
  requests: ContentRequest[]
  /** The usage each answered request reported, in order. */
  usages: Array<{ inputTokens: number; outputTokens: number }>
}

const turnText = (m: ChatMessage): string => m.content

export function contentAi(script: (request: ContentRequest) => ContentReply): ContentAi {
  const requests: ContentRequest[] = []
  const usages: ContentAi['usages'] = []
  let ids = 0
  const answer = (messages: readonly ChatMessage[], opts?: ChatOptions): ChatResult => {
    const system = opts?.system ?? ''
    const request: ContentRequest = {
      index: requests.length,
      system,
      text: [system, ...messages.map(turnText)].join('\n'),
      tools: (opts?.tools ?? []).map((t) => t.name),
      maxTokens: opts?.maxTokens,
    }
    requests.push(request)
    const reply = script(request)
    if (reply.fail === true) {
      throw new AdapterError('server_error', 'the provider answered 500', {
        context: { status: 500 },
      })
    }
    const usage = reply.usage ?? { inputTokens: 300, outputTokens: 60 }
    usages.push(usage)
    const toolCalls = (reply.calls ?? []).map((c) => ({
      id: `call_${(ids += 1)}`,
      name: c.name,
      args: c.args,
    }))
    return {
      text: reply.text ?? '',
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end',
      usage,
      model: 'content-stand-in',
      toolCalls,
    }
  }
  const ai = {
    kind: 'ai',
    providerName: 'content-stand-in',
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
    async complete(prompt: string, opts?: { maxTokens?: number }) {
      return answer([{ role: 'user', content: prompt }], opts).text
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
  return { ai, requests, usages }
}

export type RoleConfig = ContentRoleDeps['role']

/** A run's report, as the Interface states it. */
export interface RunReport {
  candidates: number
  alreadyAsked: number
  asked: string[]
  proposed: Array<{ productId: string; proposalId: string; fields: string[] }>
  skipped: Array<{ productId: string; proposalId: string }>
  withheld: Array<{
    productId: string
    proposalId: string
    reason: 'validation' | 'unsupported_claim' | 'unparsed' | 'field_not_allowed'
    detail: string[]
  }>
  stopped: null | 'token_cap' | 'provider_failed'
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  models: string[]
}

/** An insight draft, as the night shift takes it. */
export interface Draft {
  subject: string
  severity: string
  summary: string
  facts: Record<string, string | number | null>
}

/** The role block at the Interface defaults, enabled, with `over` on top. */
export function roleWith(over: Record<string, unknown> = {}): RoleConfig {
  return {
    enabled: true,
    schedule: 'weekly',
    fields: [...SEO_FIELDS],
    maxProducts: 20,
    maxTokensPerRun: 100_000,
    ...over,
  } as RoleConfig
}

/** The role's deps over a kernel's services and repositories, wired as createApp wires them. */
export function contentDeps(
  k: Kernel,
  ai: AiAdapter,
  role: Record<string, unknown> = {},
): ContentRoleDeps {
  return contentRoleDeps({
    store: k.store,
    proposalRepository: k.repos.proposal,
    products: k.services.product,
    proposals: k.services.proposals,
    ai,
    role: roleWith(role),
    config: k.config,
    logger: k.logger,
  })
}

/** Distinct product names, none a substring of another, so a request names exactly one. */
export const NAMES = [
  'Alder Tote',
  'Birch Tote',
  'Cedar Tote',
  'Dogwood Tote',
  'Elm Tote',
  'Fir Tote',
  'Ginkgo Tote',
  'Hazel Tote',
  'Holly Tote',
  'Juniper Tote',
  'Larch Tote',
  'Linden Tote',
  'Maple Tote',
  'Oak Tote',
  'Olive Tote',
  'Pine Tote',
  'Poplar Tote',
  'Rowan Tote',
  'Spruce Tote',
  'Sycamore Tote',
  'Walnut Tote',
  'Willow Tote',
  'Yew Tote',
  'Aspen Tote',
  'Beech Tote',
  'Cherry Tote',
  'Chestnut Tote',
  'Cypress Tote',
  'Hawthorn Tote',
  'Hemlock Tote',
] as const

export interface ProductSeed {
  name: string
  status?: 'draft' | 'active' | 'archived'
  description?: string
  shortDescription?: string
  seoTitle?: string
  seoDescription?: string
  metadata?: Record<string, unknown>
  variants?: Array<{ name: string; options: Array<{ name: string; value: string }> }>
  /** Its created_at and updated_at; 2026-01-01 when not given. */
  at?: Date
}

/** One product through the product service, its created_at and updated_at then set to `at` (the service stamps now). */
export async function seedProduct(k: Kernel, seed: ProductSeed): Promise<ProductSnapshot> {
  const tag = randomUUID().slice(0, 8)
  const made = await k.services.product.create({
    slug: `content-${tag}`,
    name: seed.name,
    description: seed.description ?? `${seed.name} is a tote bag.`,
    status: seed.status ?? 'active',
    ...(seed.shortDescription !== undefined && { shortDescription: seed.shortDescription }),
    seoTitle: seed.seoTitle ?? '',
    seoDescription: seed.seoDescription ?? '',
    ...(seed.metadata !== undefined && { metadata: seed.metadata }),
    variants: (seed.variants ?? [{ name: 'Default', options: [] }]).map((v, i) => ({
      sku: `CR-${tag}-${i}`,
      name: v.name,
      priceMinor: 2500,
      stock: 5,
      lowStockThreshold: 0,
      options: v.options,
    })),
  })
  // The created event is delivered after create returns: a raw write on a second connection waits for it to finish.
  await k.app.relay.drain()
  const at = (seed.at ?? new Date('2026-01-01T00:00:00.000Z')).toISOString()
  await writeRaw(
    k.dialect,
    k.target,
    'UPDATE products SET created_at = ?, updated_at = ? WHERE id = ?',
    [at, at, made.id],
  )
  return k.services.product.getById(made.id)
}

/** `n` days after 2026-01-01, for products whose age orders them. */
export const dayOf = (n: number): Date => new Date(Date.UTC(2026, 0, 1 + n))

/** The key the role records a product version under. */
export const keyOf = (p: Pick<ProductSnapshot, 'id' | 'updatedAt'>): string =>
  `content.${p.id}.${new Date(p.updatedAt).getTime()}`

/** Copy that meets every rule for a product whose own text holds `name` and nothing else it claims. */
export function goodCopy(name: string): { seoTitle: string; seoDescription: string } {
  return {
    seoTitle: `${name} for daily use`,
    seoDescription: `${name} is a roomy everyday bag with a zip pocket and sturdy handles, sized for the commute and weekend errands.`,
  }
}

export const json = (value: unknown): string => JSON.stringify(value)

/** The product a request is about: the one whose name it holds (the longest, should one name hold another). */
export function productIn<T extends { name: string }>(
  request: ContentRequest,
  products: readonly T[],
): T | undefined {
  return products
    .filter((p) => request.text.includes(p.name))
    .sort((a, b) => b.name.length - a.name.length)[0]
}

export interface ProposalRow {
  id: string
  tool: string
  command: string
  args: Record<string, unknown>
  proposerId: string | null
  agentName: string
  idempotencyKey: string | null
  status: string
  decidedByKind: string | null
  decidedBy: string | null
  reason: string | null
}

/** The proposals table as a second connection reads it, oldest first. */
export async function proposalRows(raw: RawReader): Promise<ProposalRow[]> {
  const rows = await raw.rows<Record<string, unknown>>(
    `SELECT id, tool, command, args, proposer_id, agent_name, idempotency_key, status, decided_by_kind, decided_by,
       reason FROM proposals ORDER BY created_at, id`,
  )
  const text = (v: unknown) => (v == null ? null : String(v))
  return rows.map((r) => ({
    id: String(r['id']),
    tool: String(r['tool']),
    command: String(r['command']),
    args: (typeof r['args'] === 'string' ? JSON.parse(r['args']) : r['args']) as Record<
      string,
      unknown
    >,
    proposerId: text(r['proposer_id']),
    agentName: String(r['agent_name']),
    idempotencyKey: text(r['idempotency_key']),
    status: String(r['status']),
    decidedByKind: text(r['decided_by_kind']),
    decidedBy: text(r['decided_by']),
    reason: text(r['reason']),
  }))
}
