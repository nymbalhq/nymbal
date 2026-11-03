import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

// The published UCP 2026-08-25 schemas (README.md), loaded by their `$id`s so every `$ref` resolves offline.
// `strict: false`: the schemas carry `ucp_request` and `name` annotations Ajv does not know.

const ROOT = fileURLToPath(new URL('./2026-08-25/', import.meta.url))
const ID_BASE = 'https://ucp.dev/schemas/'

function schemaFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? schemaFiles(join(dir, entry.name))
      : entry.name.endsWith('.json')
        ? [join(dir, entry.name)]
        : [],
  )
}

let ajv: Ajv2020 | undefined

function loaded(): Ajv2020 {
  if (ajv !== undefined) return ajv
  const instance = new Ajv2020({ strict: false, allErrors: true })
  addFormats(instance)
  for (const file of schemaFiles(ROOT)) {
    instance.addSchema(JSON.parse(readFileSync(file, 'utf8')) as object)
  }
  ajv = instance
  return instance
}

/**
 * The errors `value` has against the vendored schema `ref` names, relative to the schemas root
 * (`shopping/checkout.json`, `profile.json#/$defs/business_schema`); none when it conforms.
 */
export function validateUcp(ref: string, value: unknown): string[] {
  const validate = loaded().getSchema(`${ID_BASE}${ref}`)
  if (validate === undefined) throw new Error(`no vendored UCP schema ${ref}`)
  if (validate(value)) return []
  return (validate.errors ?? []).map(
    (error) =>
      `${error.instancePath || '/'} ${error.message ?? 'is invalid'} (${error.schemaPath})`,
  )
}
