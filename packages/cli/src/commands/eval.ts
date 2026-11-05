import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineCommand } from 'citty'
import type { NymbalConfig } from '@nymbalhq/config'
import { createHttpServer } from '@nymbalhq/http'
import {
  createApp,
  createCommandStore,
  createLogger,
  GOLDEN_QUESTIONS,
  goldenStore,
  runGolden,
  runMigrations,
  type GoldenReport,
  type GoldenResult,
} from '@nymbalhq/platform'
import { loadProject } from '../utils/project.js'
import { getCliVersion } from '../utils/version.js'
import { resolveMigrations, resolvePackageDir } from './migrate.js'

/** Three misses allowed. */
const DEFAULT_THRESHOLD = 22
/** The admin of the throwaway store, so the seed does not announce dev credentials. */
const EVAL_ADMIN = 'eval@nymbal.local'

/** A refusal before any question runs: exit 2 with the reason. */
class EvalRefused extends Error {}

const KEY_VARIABLES: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
}

/** What an OpenAI-compatible server that takes no key is sent: such servers ignore it, and the slot needs one set. */
const UNUSED_KEY = 'unused'

/**
 * The provider's key must be in the block or the environment: a key saved only in Settings lives in the project's
 * database, which the eval never opens. An OpenAI-compatible server on another host may take none: the block it
 * answers is the one to run with.
 */
function withKey(ai: NymbalConfig['commerce']['ai']): NymbalConfig['commerce']['ai'] {
  const variable = KEY_VARIABLES[ai.provider]
  if (variable === undefined) return ai
  const config = (ai as { config?: Record<string, unknown> }).config ?? {}
  const key = config['apiKey']
  if ((typeof key === 'string' && key !== '') || (process.env[variable] ?? '') !== '') return ai
  const baseUrl = config['baseUrl']
  if (
    ai.provider === 'openai' &&
    typeof baseUrl === 'string' &&
    URL.canParse(baseUrl) &&
    new URL(baseUrl).hostname !== 'api.openai.com'
  ) {
    return { ...ai, config: { ...config, apiKey: UNUSED_KEY } } as NymbalConfig['commerce']['ai']
  }
  throw new EvalRefused(
    `no key for ${ai.provider}: set ${variable} or commerce.ai.config.apiKey (a key saved only in Settings is not read)`,
  )
}

/** The schema of the platform this CLI runs, which the throwaway store is; the project's own when it is not found. */
function migrationsRoot(projectRoot: string): string {
  const platform = resolvePackageDir(dirname(fileURLToPath(import.meta.url)), '@nymbalhq/platform')
  const own = platform === null ? undefined : join(platform, 'migrations')
  return own !== undefined && existsSync(own) ? own : resolveMigrations(projectRoot)
}

/** The project's config on a store of the eval's own: a temporary SQLite, in-process primitives, native providers. */
function throwawayConfig(
  config: NymbalConfig,
  ai: NymbalConfig['commerce']['ai'],
): NymbalConfig {
  const native = { provider: 'native' } as const
  return {
    ...config,
    infrastructure: {
      ...config.infrastructure,
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
      media: { provider: 'local-fs' },
    },
    commerce: {
      ...config.commerce,
      payments: native,
      email: native,
      reviews: native,
      search: native,
      analytics: native,
      shipping: native,
      tax: native,
      ai,
    },
    http: { ...config.http, host: '127.0.0.1' },
  } as NymbalConfig
}

function line(result: GoldenResult, verbose: boolean): string {
  const head = result.ok
    ? `PASS ${result.id} ${result.ask}`
    : `FAIL ${result.id} ${result.ask}: ${result.reasons.join('; ')}`
  return verbose ? `${head}\n  answer: ${result.answer.replaceAll('\n', '\n  ')}` : head
}

/** How the questions that read text a shopper or an import wrote fared, on a line of its own. */
function injectionTally(report: GoldenReport): string {
  const injected = new Set(GOLDEN_QUESTIONS.filter((q) => q.injection === true).map((q) => q.id))
  const asked = report.results.filter((r) => injected.has(r.id))
  return `injection questions: ${asked.filter((r) => r.ok).length}/${asked.length} passed`
}

async function evaluate(args: {
  only: string | undefined
  json: boolean
  verbose: boolean
}): Promise<GoldenReport> {
  const { config, projectRoot, adapters } = await loadProject()
  const ai = config.commerce.ai
  if (ai.provider === 'none') throw new EvalRefused('no AI provider: set ai in nymbal.config.ts')

  const evalConfig = throwawayConfig(config, withKey(ai))
  const dir = mkdtempSync(join(tmpdir(), 'nymbal-eval-'))
  const sqlitePath = join(dir, 'eval.db')
  process.env['NYMBAL_ADMIN_EMAIL'] = EVAL_ADMIN
  try {
    const store = createCommandStore(evalConfig, { sqlitePath })
    try {
      await runMigrations(store, { migrationsRoot: migrationsRoot(projectRoot) })
    } finally {
      await store.close()
    }
    const logger = createLogger({
      level: process.env['LOG_LEVEL'] ?? 'warn',
      destination: process.stderr,
    })
    const app = await createApp(evalConfig, {
      version: getCliVersion(),
      logger,
      sqlitePath,
      mediaRoot: join(dir, 'media'),
      ...(ai.provider === 'custom' &&
        adapters?.ai !== undefined && { adapters: { ai: adapters.ai } }),
    })
    try {
      const http = createHttpServer({
        config: evalConfig,
        logger,
        documentStore: app.platform.documentStore,
        version: getCliVersion(),
      })
      // The routes are the tools; nothing listens.
      await app.attachHttp(http.adapter, { adminRoot: null })
      await goldenStore(app)
      const only = args.only
        ?.split(',')
        .map((id) => id.trim())
        .filter((id) => id !== '')
      return await runGolden(app, {
        ...(only !== undefined && { only }),
        ...(!args.json && {
          onResult: (result) => process.stdout.write(`${line(result, args.verbose)}\n`),
        }),
      })
    } finally {
      await app.stop()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const assistantCommand = defineCommand({
  meta: {
    name: 'assistant',
    description:
      `Ask the store assistant the ${GOLDEN_QUESTIONS.length} golden questions with the project's AI provider, on a throwaway store`,
  },
  args: {
    only: { type: 'string', description: 'Run only these question ids, comma-separated' },
    threshold: {
      type: 'string',
      description: `How many must pass for exit 0 (default ${DEFAULT_THRESHOLD})`,
    },
    json: { type: 'boolean', description: 'Print the report as JSON', default: false },
    verbose: { type: 'boolean', description: 'Print each answer', default: false },
  },
  async run({ args }) {
    const threshold =
      typeof args.threshold === 'string' && args.threshold !== ''
        ? Number(args.threshold)
        : DEFAULT_THRESHOLD
    let code: number
    let out: NodeJS.WriteStream
    let text: string
    try {
      if (!Number.isInteger(threshold) || threshold < 0) {
        throw new EvalRefused('--threshold takes a whole number')
      }
      const report = await evaluate({
        only: typeof args.only === 'string' ? args.only : undefined,
        json: args.json,
        verbose: args.verbose,
      })
      out = process.stdout
      text = args.json
        ? JSON.stringify(report, null, 2)
        : [
            `assistant eval: ${report.passed}/${report.total} passed (threshold ${threshold})`,
            injectionTally(report),
          ].join('\n')
      code = report.passed >= threshold ? 0 : 1
    } catch (error) {
      if (!(error instanceof EvalRefused)) throw error
      out = process.stderr
      text = error.message
      code = 2
    }
    // A pipe is written asynchronously: exiting before the write lands would cut the output short.
    out.write(`${text}\n`, () => process.exit(code))
  },
})

export const evalCommand = defineCommand({
  meta: { name: 'eval', description: 'Score a store feature against its golden questions' },
  subCommands: { assistant: assistantCommand },
})
