import { z, type ZodTypeAny } from 'zod'
import type { JsonSchemaObject, ToolDefinition } from '@nymbalhq/types'
import { routeSchemas, type RouteSchema } from '../routes/schemas.js'
import type { RouteTable } from './route-table.js'

export const PARTS = ['params', 'query', 'body'] as const

/** `admin.products.create` → `admin_products_create`: not every model API that lists MCP tools accepts a dot. */
export function toolName(dotted: string): string {
  return dotted.split('.').join('_')
}

/** The object a part of a route's input is, and whether the part itself may be left out. */
export function partShape(schema: ZodTypeAny | undefined): {
  object: z.ZodObject | undefined
  optional: boolean
} {
  let at: unknown = schema
  let optional = schema === undefined
  while (at instanceof z.ZodOptional) {
    optional = true
    at = at.unwrap()
  }
  return { object: at instanceof z.ZodObject ? at : undefined, optional }
}

function addProperty(
  schema: JsonSchemaObject,
  key: string,
  property: unknown,
  required: boolean,
  where: string,
): void {
  const properties = (schema.properties ??= {})
  if (Object.hasOwn(properties, key)) {
    throw new Error(`route ${where}: ${key} is declared twice in its tool's input`)
  }
  properties[key] = property
  if (required) (schema.required ??= []).push(key)
}

/**
 * One JSON Schema object for a route's input: the keys of its params, query and body side by side, each as the route
 * parses it. A key two parts share would make the call ambiguous, so it is refused.
 */
export function jsonSchemaOf(entry: RouteSchema): JsonSchemaObject {
  const schema: JsonSchemaObject = { type: 'object', properties: {}, additionalProperties: false }
  const defs: Record<string, unknown> = {}
  for (const part of PARTS) {
    const { object, optional } = partShape(entry[part])
    if (object === undefined) continue
    const converted = z.toJSONSchema(object, { io: 'input', unrepresentable: 'any' }) as {
      properties?: Record<string, unknown>
      required?: string[]
      $defs?: Record<string, unknown>
    }
    const required = new Set(optional ? [] : (converted.required ?? []))
    for (const [key, property] of Object.entries(converted.properties ?? {})) {
      addProperty(schema, key, property, required.has(key), `${entry.name} (${part})`)
    }
    Object.assign(defs, converted.$defs)
  }
  if (Object.keys(defs).length > 0) schema['$defs'] = defs
  return schema
}

const IDEMPOTENCY_KEY = {
  type: 'string',
  pattern: '^[A-Za-z0-9._:-]{1,128}$',
  description: 'Runs this write once: a repeat with the same key answers what the first did.',
}

function handleProperty(argument: string): unknown {
  return {
    type: 'string',
    description: `The ${argument} this call works on: the ${argument}Handle an earlier call answered. Left out, a new one is opened.`,
  }
}

/**
 * The agent tools of the routes in `table`: one per route the registry does not keep from agents (`tool: false`).
 * Stream routes are never in the table.
 */
export function toolsOf(table: RouteTable): ToolDefinition[] {
  const tools: ToolDefinition[] = []
  for (const key of table.keys()) {
    const entry = routeSchemas[key]
    const route = table.get(key)
    if (entry === undefined || route === undefined || entry.tool === false) continue
    const [method, path] = key.split(' ') as [ToolDefinition['route']['method'], string]
    const kind: ToolDefinition['kind'] =
      method === 'GET' ? 'read' : entry.command === null ? 'session' : 'command'
    const inputSchema = jsonSchemaOf(entry)
    for (const argument of Object.keys(entry.handles ?? {})) {
      addProperty(inputSchema, argument, handleProperty(argument), false, entry.name)
    }
    if (kind === 'command' && path.startsWith('/api/admin/')) {
      addProperty(inputSchema, 'idempotencyKey', IDEMPOTENCY_KEY, false, entry.name)
    }
    tools.push({
      name: toolName(entry.name),
      title: entry.name,
      description: entry.description,
      inputSchema,
      scope: route.scope,
      kind,
      route: { method, path, command: entry.command },
    })
  }
  return tools
}
