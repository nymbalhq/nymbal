import { existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createJiti } from 'jiti'
import { z } from 'zod'
import { ConfigError } from '@nymbal/types'
import { nymbalConfigSchema, type NymbalConfig } from './schema.js'

const CONFIG_FILE = 'nymbal.config.ts'

export interface LoadedConfig {
  config: NymbalConfig
  path: string
  projectRoot: string
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
  let raw: unknown
  try {
    raw = await jiti.import(path, { default: true })
  } catch (err) {
    throw new ConfigError(`Failed to load ${path}: ${(err as Error).message}`, {
      cause: err,
      context: { path },
    })
  }

  try {
    const config = nymbalConfigSchema.parse(raw)
    return { config, path, projectRoot: dirname(path) }
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

function formatZodError(err: z.ZodError, path: string): string {
  const lines = err.issues.map((issue) => {
    const at = issue.path.length > 0 ? issue.path.join('.') : '<root>'
    return `  • ${at}: ${issue.message}`
  })
  return `Invalid configuration in ${path}:\n${lines.join('\n')}`
}
