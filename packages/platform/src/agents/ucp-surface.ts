import { z } from 'zod'
import {
  CART_LINE_MAX_QTY,
  type AgentSurfaceAdapter,
  type AgentSurfaceCapabilities,
  type AgentSurfaceUrls,
  type Caller,
  type Cart,
  type JsonSchemaObject,
  type ToolDefinition,
  type ToolResult,
  type ToolSurface,
} from '@nymbalhq/types'
import { agentNameOf } from './agent-name.js'
import {
  catalogUcp,
  ucpCheckout,
  ucpError,
  ucpProduct,
  type ListedProduct,
  type UcpLink,
  type UcpMessage,
  type UcpProduct,
} from './catalog.js'
import {
  UCP_CAPABILITY,
  UCP_ENDPOINT_PATH,
  UCP_PROFILE_PATH,
  ucpProfile,
  type UcpCapability,
} from './profile.js'

/** What an agent can do through the UCP surface; the admin dashboard names the same. */
export const UCP_CAPABILITIES: Readonly<AgentSurfaceCapabilities> = Object.freeze({
  search: true,
  lookup: true,
  checkout: 'handoff',
})

export interface UcpSurfaceDeps {
  /** The app's route tools, which every UCP call runs through. */
  mcp: Pick<ToolSurface, 'call'>
  /** The slug of the product a variant id belongs to, or null. */
  variants: (variantId: string) => Promise<string | null>
  /** The live guest cart a token names, or null for an unknown, expired or customer-claimed one. */
  cart: (token: string) => Promise<Cart | null>
  urls: () => AgentSurfaceUrls
  links: readonly UcpLink[]
}

/** The most lines one `create_checkout` takes. */
const MAX_LINES = 50
/** The most ids one `lookup_catalog` takes, and the longest id: each id costs up to three reads. */
const MAX_IDS = 50
const MAX_ID_LENGTH = 200
/** The most products one catalogue page holds, as the catalogue routes cap it. */
const MAX_PAGE = 100

/** UCP's `meta` (the platform's profile, an idempotency key); optional, so a plain MCP client can call. */
const meta = z
  .object({})
  .loose()
  .optional()
  .describe("UCP request metadata: `ucp-agent.profile` names the calling platform's profile URL.")

const inputs = {
  search_catalog: z.object({
    meta,
    catalog: z.object({
      query: z.string().optional(),
      pagination: z
        .object({ cursor: z.string().optional(), limit: z.number().int().min(1).optional() })
        .optional(),
    }),
  }),
  lookup_catalog: z.object({
    meta,
    catalog: z.object({ ids: z.array(z.string().max(MAX_ID_LENGTH)).min(1).max(MAX_IDS) }),
  }),
  get_product: z.object({
    meta,
    catalog: z.object({ id: z.string().min(1) }),
  }),
  create_checkout: z.object({
    meta,
    checkout: z.object({
      line_items: z
        .array(
          z.object({
            item: z.object({ id: z.string().min(1) }),
            quantity: z.number().int().min(1).max(CART_LINE_MAX_QTY),
          }),
        )
        .min(1)
        .max(MAX_LINES),
    }),
  }),
  get_checkout: z.object({ meta, id: z.string().min(1) }),
}

type ToolName = keyof typeof inputs
type Input<K extends ToolName> = z.infer<(typeof inputs)[K]>

const DESCRIBED: Record<
  ToolName,
  { title: string; description: string; kind: ToolDefinition['kind']; capability: UcpCapability }
> = {
  search_catalog: {
    title: 'Search the catalogue',
    description:
      'Search the store’s products by text, or list them all with no query, a page at a time (at most 100).',
    kind: 'read',
    capability: UCP_CAPABILITY.search,
  },
  lookup_catalog: {
    title: 'Look up products',
    description:
      'Resolve product ids, handles or variant ids to products; each variant names the ids it matched.',
    kind: 'read',
    capability: UCP_CAPABILITY.lookup,
  },
  get_product: {
    title: 'Get a product',
    description: 'One product with its variants, by product id, handle or any of its variant ids.',
    kind: 'read',
    capability: UCP_CAPABILITY.lookup,
  },
  create_checkout: {
    title: 'Create a checkout',
    description:
      'Open a checkout of up to 50 lines (variant id and quantity 1-99). The buyer pays on the store’s checkout page: open continue_url in their browser.',
    kind: 'session',
    capability: UCP_CAPABILITY.checkout,
  },
  get_checkout: {
    title: 'Get a checkout',
    description: 'Read a checkout create_checkout opened, by its id, while it is live.',
    kind: 'read',
    capability: UCP_CAPABILITY.checkout,
  },
}

const TOOLS: ToolDefinition[] = (Object.keys(inputs) as ToolName[]).map((name) => ({
  name,
  title: DESCRIBED[name].title,
  description: DESCRIBED[name].description,
  inputSchema: z.toJSONSchema(inputs[name], {
    io: 'input',
    unrepresentable: 'any',
  }) as JsonSchemaObject,
  scope: 'public',
  kind: DESCRIBED[name].kind,
  route: { method: 'POST', path: UCP_ENDPOINT_PATH, command: null },
}))

function answer(structured: Record<string, unknown>, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
    ...(isError && { isError: true }),
  }
}

function failure(capability: UcpCapability | undefined, messages: UcpMessage[]): ToolResult {
  return answer(ucpError(capability, messages), true)
}

/** A Zod issue path as the RFC 9535 JSONPath a UCP message points with. */
function jsonPath(path: ReadonlyArray<PropertyKey>): string {
  return path.reduce<string>(
    (at, key) => (typeof key === 'number' ? `${at}[${key}]` : `${at}.${String(key)}`),
    '$',
  )
}

function routeFailure(capability: UcpCapability, result: ToolResult): ToolResult {
  const { code, message } = (result.structuredContent ?? {}) as {
    code?: unknown
    message?: unknown
  }
  return failure(capability, [
    {
      type: 'error',
      code: typeof code === 'string' ? code : 'internal',
      severity: 'recoverable',
      content: typeof message === 'string' ? message : 'The store could not answer',
    },
  ])
}

/** What a refused cart line answers, by the cart route's code. */
const LINE_CODE: Record<string, string> = {
  'cart.variant_missing': 'not_found',
  'cart.out_of_stock': 'out_of_stock',
  'cart.qty_limit': 'quantity_limit',
}

/**
 * `search_catalog` with `catalog`, at the origins given: the catalogue route's page mapped to UCP, less any product
 * with no price. The feed is this with no query.
 */
export async function searchCatalog(
  mcp: UcpSurfaceDeps['mcp'],
  catalog: Input<'search_catalog'>['catalog'],
  caller: Caller,
  urls: AgentSurfaceUrls,
): Promise<ToolResult> {
  const query = catalog.query?.trim() ?? ''
  const { cursor, limit } = catalog.pagination ?? {}
  const args = {
    ...(limit !== undefined && { limit: String(Math.min(MAX_PAGE, limit)) }),
    ...(cursor !== undefined && { cursor }),
  }
  const page =
    query === ''
      ? await mcp.call('products_list', args, caller)
      : await mcp.call('products_search', { ...args, q: query }, caller)
  if (page.isError === true) return routeFailure(UCP_CAPABILITY.search, page)
  const { items, nextCursor } = (page.structuredContent ?? {}) as {
    items?: ListedProduct[]
    nextCursor?: string | null
  }
  const products = (items ?? []).flatMap((item) => ucpProduct(item, urls) ?? [])
  return answer({
    ucp: catalogUcp(UCP_CAPABILITY.search),
    products,
    pagination:
      typeof nextCursor === 'string' && nextCursor !== ''
        ? { has_next_page: true, cursor: nextCursor }
        : { has_next_page: false },
  })
}

/**
 * The UCP shopping service over MCP: catalogue search and lookup, and a checkout the buyer completes on the store's
 * own page. Each call runs the store's routes through `mcp` as the calling agent, so their gates and schemas hold;
 * none runs a command tool, so nothing here places an order or moves stock.
 */
export function createUcpSurface(deps: UcpSurfaceDeps): AgentSurfaceAdapter {
  const { mcp } = deps

  /** The listed product an id names: its slug, or one of its variant ids (then that variant). */
  async function resolve(
    id: string,
    caller: Caller,
  ): Promise<{ product: ListedProduct; mapped: UcpProduct; variantId?: string } | null> {
    const found = async (slug: string) => {
      const result = await mcp.call('products_get', { slug }, caller)
      if (result.isError === true) return null
      const product = result.structuredContent as unknown as ListedProduct
      const mapped = ucpProduct(product, deps.urls())
      return mapped === null ? null : { product, mapped }
    }
    const bySlug = await found(id)
    if (bySlug !== null) return bySlug
    const slug = await deps.variants(id)
    const byVariant = slug === null ? null : await found(slug)
    if (byVariant === null || !byVariant.product.variants.some((v) => v.id === id)) return null
    return { ...byVariant, variantId: id }
  }

  function notFound(capability: UcpCapability, id: string, path: string): ToolResult {
    return failure(capability, [
      {
        type: 'error',
        code: 'not_found',
        severity: 'recoverable',
        path,
        content: `Nothing in this store has the id ${JSON.stringify(id)}.`,
      },
    ])
  }

  async function lookup(ids: string[], caller: Caller): Promise<ToolResult> {
    const products = new Map<
      string,
      {
        mapped: UcpProduct
        inputs: Map<string, NonNullable<UcpProduct['variants'][number]['inputs']>>
      }
    >()
    const messages: UcpMessage[] = []
    for (const [index, id] of ids.entries()) {
      const resolved = await resolve(id, caller)
      if (resolved === null) {
        messages.push({
          type: 'info',
          code: 'not_found',
          path: `$.catalog.ids[${index}]`,
          content: `Nothing in this store has the id ${JSON.stringify(id)}.`,
        })
        continue
      }
      const entry = products.get(resolved.mapped.id) ?? {
        mapped: resolved.mapped,
        inputs: new Map(),
      }
      products.set(resolved.mapped.id, entry)
      // A product id or handle resolves to one representative variant, the first in stock (UCP's `featured`).
      const variants = resolved.mapped.variants
      const variantId =
        resolved.variantId ?? (variants.find((v) => v.availability.available) ?? variants[0]!).id
      const match = resolved.variantId === undefined ? 'featured' : 'exact'
      entry.inputs.set(variantId, [...(entry.inputs.get(variantId) ?? []), { id, match }])
    }
    return answer({
      ucp: catalogUcp(UCP_CAPABILITY.lookup),
      // A variant no requested id resolved to is left out, as UCP's lookup asks.
      products: [...products.values()].map(({ mapped, inputs: matched }) => ({
        ...mapped,
        variants: mapped.variants.flatMap((variant) => {
          const correlated = matched.get(variant.id)
          return correlated === undefined ? [] : [{ ...variant, inputs: correlated }]
        }),
      })),
      ...(messages.length > 0 && { messages }),
    })
  }

  async function createCheckout(
    lines: Array<{ item: { id: string }; quantity: number }>,
    caller: Caller,
  ): Promise<ToolResult> {
    const capability = UCP_CAPABILITY.checkout
    const opened = await mcp.call('cart_get', {}, caller)
    const token = opened.structuredContent?.['cartHandle']
    if (opened.isError === true || typeof token !== 'string')
      return routeFailure(capability, opened)
    const refused: UcpMessage[] = []
    for (const [index, line] of lines.entries()) {
      const added = await mcp.call(
        'cart_addItem',
        { cart: token, variantId: line.item.id, qty: line.quantity },
        caller,
      )
      if (added.isError !== true) continue
      const { code, message } = (added.structuredContent ?? {}) as {
        code?: unknown
        message?: unknown
      }
      refused.push({
        type: 'error',
        code: (typeof code === 'string' && LINE_CODE[code]) || 'item_unavailable',
        severity: 'recoverable',
        path: `$.checkout.line_items[${index}]`,
        content: typeof message === 'string' ? message : 'This line could not be added',
      })
    }
    // Refused whole: the agent fixes the lines and asks again; the partial cart expires unused.
    if (refused.length > 0) return failure(capability, refused)
    const cart = await deps.cart(token)
    if (cart === null) return notFound(capability, token, '$.id')
    return answer(ucpCheckout(cart, deps.urls(), deps.links))
  }

  const handlers: { [K in ToolName]: (input: Input<K>, caller: Caller) => Promise<ToolResult> } = {
    search_catalog: (input, caller) => searchCatalog(mcp, input.catalog, caller, deps.urls()),
    lookup_catalog: (input, caller) => lookup(input.catalog.ids, caller),
    async get_product(input, caller) {
      const resolved = await resolve(input.catalog.id, caller)
      if (resolved === null)
        return notFound(UCP_CAPABILITY.lookup, input.catalog.id, '$.catalog.id')
      return answer({ ucp: catalogUcp(UCP_CAPABILITY.lookup), product: resolved.mapped })
    },
    create_checkout: (input, caller) => createCheckout(input.checkout.line_items, caller),
    async get_checkout(input) {
      const cart = await deps.cart(input.id)
      if (cart === null) return notFound(UCP_CAPABILITY.checkout, input.id, '$.id')
      return answer(ucpCheckout(cart, deps.urls(), deps.links))
    },
  }

  const tools: ToolSurface = {
    list() {
      return TOOLS
    },

    async call(name, args, caller) {
      if (!Object.hasOwn(inputs, name)) {
        return failure(undefined, [
          {
            type: 'error',
            code: 'not_found',
            severity: 'unrecoverable',
            content: `No tool is named ${name}`,
          },
        ])
      }
      const tool = name as ToolName
      const { capability } = DESCRIBED[tool]
      const parsed = inputs[tool].safeParse(args ?? {})
      if (!parsed.success) {
        return failure(
          capability,
          parsed.error.issues.map((issue) => ({
            type: 'error',
            code: issue.path.at(-1) === 'quantity' ? 'quantity_limit' : 'invalid_input',
            severity: 'recoverable',
            path: jsonPath(issue.path),
            content: issue.message,
          })),
        )
      }
      const agentName = agentNameOf(parsed.data.meta, caller.agent)
      const who: Caller = {
        ...caller,
        agent: agentName === caller.agent.name ? caller.agent : { name: agentName },
      }
      const run = handlers[tool] as (input: unknown, caller: Caller) => Promise<ToolResult>
      return run(parsed.data, who)
    },
  }

  return {
    name: 'ucp',
    capabilities: { ...UCP_CAPABILITIES },
    wellKnown: { path: UCP_PROFILE_PATH, document: ucpProfile },
    endpoint: { path: UCP_ENDPOINT_PATH, tools },
  }
}
