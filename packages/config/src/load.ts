import { existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createJiti } from 'jiti'
import { z } from 'zod'
import { ConfigError, type CommerceSlotAdapters } from '@nymbalhq/types'
import { KNOWN_PROVIDERS } from './known-providers.js'
import { nymbalConfigSchema, type NymbalConfig } from './schema.js'

const CONFIG_FILE = 'nymbal.config.ts'

export interface LoadedConfig {
  config: NymbalConfig
  path: string
  projectRoot: string
  /** The module's named `adapters` export: one adapter per slot whose provider is `custom`, for createApp. */
  adapters?: Partial<CommerceSlotAdapters>
}

export function findConfigFile(startDir: string): string | null {
  let current = isAbsolute(startDir) ? startDir : resolve(startDir)
  while (true) {
    const candidate = resolve(current, CONFIG_FILE)
    if (existsSync(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export async function loadConfig(startDir: string = process.cwd()): Promise<LoadedConfig> {
  const path = findConfigFile(startDir)
  if (!path) {
    throw new ConfigError(
      `Could not find ${CONFIG_FILE} in ${startDir} or any parent directory.`,
      { context: { startDir } },
    )
  }

  const jiti = createJiti(pathToFileURL(path).href, { interopDefault: true })
  let mod: Record<string, unknown>
  try {
    mod = await jiti.import<Record<string, unknown>>(path)
  } catch (err) {
    throw new ConfigError(`Failed to load ${path}: ${(err as Error).message}`, {
      cause: err,
      context: { path },
    })
  }

  const raw = mod['default'] ?? mod
  const adapters = adaptersExport(mod['adapters'], path)
  try {
    const config = nymbalConfigSchema.parse(raw)
    return { config, path, projectRoot: dirname(path), ...(adapters !== undefined && { adapters }) }
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new ConfigError(formatZodError(err, path), {
        cause: err,
        context: { path, issues: err.issues },
      })
    }
    throw err
  }
}

/** The `adapters` export, keyed by commerce slot; anything else is a mistake worth naming before createApp runs. */
function adaptersExport(value: unknown, path: string): Partial<CommerceSlotAdapters> | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${path}: the adapters export must be an object keyed by commerce slot`, {
      code: 'config.adapters_invalid',
      context: { path },
    })
  }
  const slots = Object.keys(KNOWN_PROVIDERS)
  const unknown = Object.keys(value).filter((key) => !slots.includes(key))
  if (unknown.length > 0) {
    throw new ConfigError(
      `${path}: the adapters export names ${unknown.join(', ')}, which is no commerce slot (${slots.join(', ')})`,
      { code: 'config.adapters_invalid', context: { path, unknown } },
    )
  }
  return value as Partial<CommerceSlotAdapters>
}

function formatZodError(err: z.ZodError, path: string): string {
  const lines = err.issues.map((issue) => {
    const at = issue.path.length > 0 ? issue.path.join('.') : '<root>'
    return `  • ${at}: ${issue.message}`
  })
  return `Invalid configuration in ${path}:\n${lines.join('\n')}`
}
