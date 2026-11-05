import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

// The published ACP 2026-04-17 JSON Schemas (README.md), each a bundle with no external `$ref`, loaded under its own
// `$id` so nothing reaches the network. `strict: false`: the bundles carry `example` keywords Ajv does not know.

const ROOT = fileURLToPath(new URL('./2026-04-17/', import.meta.url))

let loaded: { ajv: Ajv2020; ids: Map<string, string> } | undefined

function schemas(): { ajv: Ajv2020; ids: Map<string, string> } {
  if (loaded !== undefined) return loaded
  const ajv = new Ajv2020({ strict: false, allErrors: true })
  addFormats(ajv)
  const ids = new Map<string, string>()
  for (const file of readdirSync(ROOT).filter((f) => /^schema\..+\.json$/.test(f))) {
    const schema = JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as { $id?: unknown }
    if (typeof schema.$id !== 'string') throw new Error(`vendored ACP schema ${file} has no $id`)
    ajv.addSchema(schema as object)
    ids.set(file, schema.$id)
  }
  loaded = { ajv, ids }
  return loaded
}

/**
 * The errors `value` has against the vendored schema `ref` names, a file and an optional pointer
 * (`schema.agentic_checkout.json#/$defs/CheckoutSession`); none when it conforms.
 */
export function validateAcp(ref: string, value: unknown): string[] {
  const [file, pointer = ''] = ref.split('#')
  const { ajv, ids } = schemas()
  const id = ids.get(file ?? '')
  if (id === undefined) throw new Error(`no vendored ACP schema ${file}`)
  const validate = ajv.getSchema(pointer === '' ? id : `${id}#${pointer}`)
  if (validate === undefined) throw new Error(`no vendored ACP schema ${ref}`)
  if (validate(value)) return []
  return (validate.errors ?? []).map(
    (error) =>
      `${error.instancePath || '/'} ${error.message ?? 'is invalid'} (${error.schemaPath})`,
  )
}

/** One named example of the vendored `examples.agentic_checkout.json`. */
export function acpExample(name: string): unknown {
  const examples = JSON.parse(
    readFileSync(join(ROOT, 'examples.agentic_checkout.json'), 'utf8'),
  ) as Record<string, unknown>
  if (!(name in examples)) throw new Error(`no ACP example ${name}`)
  return examples[name]
}
