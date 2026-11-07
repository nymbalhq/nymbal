import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_CUSTOMER_FIELDS } from '@nymbalhq/config'
import type { AssistantEvalStamp, GoldenTally } from '@nymbalhq/platform'

/** How many golden questions must pass for exit 0: three misses allowed. The least a stamp may record. */
export const DEFAULT_THRESHOLD = 24

/** The hosted APIs a stamp may record a run against: a stand-in or a proxy answers on another host. */
const PROVIDER_HOSTS: Record<string, string> = {
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
}

/**
 * Why the project's `ai` block cannot record a stamp, or undefined when it can: only Anthropic's or OpenAI's own API
 * scores the prompt the store ships, so a custom adapter, a stand-in and any other OpenAI-compatible server are refused.
 */
export function stampRefusal(ai: { provider: string; config?: unknown }): string | undefined {
  const host = PROVIDER_HOSTS[ai.provider]
  if (host === undefined) {
    return `--stamp records a run against anthropic or openai, not ${ai.provider}`
  }
  const baseUrl = (ai.config as { baseUrl?: unknown } | undefined)?.baseUrl
  if (baseUrl === undefined) return undefined
  const at = typeof baseUrl === 'string' && URL.canParse(baseUrl) ? new URL(baseUrl) : undefined
  if (at?.protocol === 'https:' && at.hostname === host) return undefined
  return `--stamp records a run against ${host}, not the baseUrl ${String(baseUrl)}: remove commerce.ai.config.baseUrl`
}

/**
 * Why this run cannot record a stamp, or undefined when it can. The stamp hashes both prompts and every customer tool,
 * so the run must ask with them: every question, the default threshold or above, the customer tools on and the default
 * mask (the masked prompt; masking off is the plain prompt alone).
 */
export function stampRunRefusal(run: {
  ai: { provider: string; config?: unknown }
  only: string | undefined
  threshold: number
  customerData: boolean
  mask: readonly string[]
}): string | undefined {
  const mask = new Set(run.mask)
  const defaultMask =
    mask.size === DEFAULT_CUSTOMER_FIELDS.length &&
    DEFAULT_CUSTOMER_FIELDS.every((field) => mask.has(field))
  return (
    stampRefusal(run.ai) ??
    (run.only !== undefined && run.only !== ''
      ? '--stamp records a run of every question, not --only'
      : run.threshold < DEFAULT_THRESHOLD
        ? `--stamp records a run at the default threshold (${DEFAULT_THRESHOLD}) or above`
        : !run.customerData
          ? '--stamp records a run with every tool offered: agents.assistant.customerData is false'
          : !defaultMask
            ? `--stamp records a run with the default mask (${DEFAULT_CUSTOMER_FIELDS.join(', ')}): remove agents.assistant.mask`
            : undefined)
  )
}

/**
 * Why `file` cannot take the stamp, or undefined when it can: checked before the first question, so a paid run never
 * ends on a path it cannot write. The path is read from where the command runs.
 */
export function stampFileRefusal(file: string): string | undefined {
  const dir = dirname(file)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return `--stamp ${file}: there is no directory ${dir} (a relative path is read from where the command runs)`
  }
  if (existsSync(file) && !statSync(file).isFile()) return `--stamp ${file}: not a file`
  const target = existsSync(file) ? file : dir
  try {
    accessSync(target, constants.W_OK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EROFS') throw error
    return `--stamp ${file}: ${target} is not writable (${code})`
  }
  return undefined
}

/** The stamp a finished run records, or undefined when fewer than `threshold` questions passed. */
export function stampOf(run: {
  hash: string
  provider: string
  models: readonly string[]
  tally: GoldenTally
  threshold: number
  date: Date
}): AssistantEvalStamp | undefined {
  if (run.tally.passed < run.threshold) return undefined
  return {
    hash: run.hash,
    provider: run.provider,
    model: run.models.length === 0 ? null : [...new Set(run.models)].join(', '),
    runs: run.tally.runs,
    passed: run.tally.passed,
    total: run.tally.total,
    threshold: run.threshold,
    date: run.date.toISOString().slice(0, 10),
  }
}
