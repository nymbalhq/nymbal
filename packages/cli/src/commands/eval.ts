import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineCommand } from 'citty'
import type { LoadedConfig, NymbalConfig } from '@nymbalhq/config'
import { createHttpServer } from '@nymbalhq/http'
import {
  assistantEvalHash,
  createApp,
  createCommandStore,
  createLogger,
  GOLDEN_QUESTIONS,
  GoldenAdapterError,
  goldenStore,
  runGolden,
  runMigrations,
  tallyGolden,
  type GoldenCall,
  type GoldenReport,
  type GoldenResult,
  type GoldenTally,
  type GoldenUsage,
} from '@nymbalhq/platform'
import { loadProject } from '../utils/project.js'
import { getCliVersion } from '../utils/version.js'
import { DEFAULT_THRESHOLD, stampFileRefusal, stampOf, stampRunRefusal } from './eval-stamp.js'
import { resolveMigrations, resolvePackageDir } from './migrate.js'

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
function throwawayConfig(config: NymbalConfig, ai: NymbalConfig['commerce']['ai']): NymbalConfig {
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

/** How much of a call's arguments a verbose line shows. */
const ARGS_SHOWN = 200

function callLine(call: GoldenCall): string {
  const args = call.args === null ? '-' : JSON.stringify(call.args).slice(0, ARGS_SHOWN)
  return `  call: ${call.name} ${args} -> ${call.outcome}`
}

function line(result: GoldenResult, verbose: boolean): string {
  const head = result.ok
    ? `PASS ${result.id} ${result.ask}`
    : `FAIL ${result.id} ${result.ask}: ${result.reasons.join('; ')}`
  if (!verbose) return head
  return [
    head,
    ...result.trace.map(callLine),
    `  answer: ${result.answer.replaceAll('\n', '\n  ')}`,
  ].join('\n')
}

/** How the questions that read text a shopper or an import wrote fared by majority, on a line of its own. */
function injectionTally(tally: GoldenTally): string {
  const injected = new Set(GOLDEN_QUESTIONS.filter((q) => q.injection === true).map((q) => q.id))
  const asked = tally.questions.filter((q) => injected.has(q.id))
  return `injection questions: ${asked.filter((q) => q.ok).length}/${asked.length} passed`
}

const totalOf = (usages: readonly GoldenUsage[]): GoldenUsage => ({
  inputTokens: usages.reduce((n, u) => n + u.inputTokens, 0),
  outputTokens: usages.reduce((n, u) => n + u.outputTokens, 0),
  cacheReadTokens: usages.reduce((n, u) => n + u.cacheReadTokens, 0),
  cacheWriteTokens: usages.reduce((n, u) => n + u.cacheWriteTokens, 0),
})

/** The tokens a run, or all of them, used: input split by the prompt cache, then output. */
function tokensLine(label: string, u: GoldenUsage): string {
  const uncached = u.inputTokens - u.cacheWriteTokens - u.cacheReadTokens
  return `${label}: ${u.inputTokens} in (${uncached} uncached, ${u.cacheWriteTokens} cache write, ${u.cacheReadTokens} cache read), ${u.outputTokens} out`
}

/** A whole number of at least 1, as `--runs` takes it; undefined for anything else. */
function runsOf(value: unknown): number | undefined {
  if (value === undefined || value === '') return 1
  return typeof value === 'string' && /^\d+$/.test(value) && Number(value) >= 1
    ? Number(value)
    : undefined
}

/** One run's report and the hash of the prompt and tools it asked with (the stamp's). */
interface Evaluated {
  report: GoldenReport
  hash: string
}

async function evaluate(
  project: LoadedConfig,
  args: {
    only: string | undefined
    json: boolean
    verbose: boolean
  },
): Promise<Evaluated> {
  const { config, projectRoot, adapters } = project
  const ai = config.commerce.ai
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
        network: app.network,
      })
      // The routes are the tools; nothing listens.
      await app.attachHttp(http.adapter, { adminRoot: null })
      await goldenStore(app)
      const hash = assistantEvalHash(app.assistantTools!)
      const only = args.only
        ?.split(',')
        .map((id) => id.trim())
        .filter((id) => id !== '')
      const report = await runGolden(app, {
        ...(only !== undefined && { only }),
        ...(!args.json && {
          onResult: (result) => process.stdout.write(`${line(result, args.verbose)}\n`),
        }),
      })
      return { report, hash }
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
    description: `Ask the store assistant the ${GOLDEN_QUESTIONS.length} golden questions with the project's AI provider, on a throwaway store`,
  },
  args: {
    only: { type: 'string', description: 'Run only these question ids, comma-separated' },
    threshold: {
      type: 'string',
      description: `How many must pass for exit 0 (default ${DEFAULT_THRESHOLD})`,
    },
    runs: {
      type: 'string',
      description:
        'Ask the set this many times, each on a fresh store, and judge each question by majority (default 1)',
    },
    json: {
      type: 'boolean',
      description: 'Print the tally and every run’s report as JSON',
      default: false,
    },
    verbose: {
      type: 'boolean',
      description: 'Print each call, its arguments and outcome, and each answer',
      default: false,
    },
    stamp: {
      type: 'string',
      description:
        'Write the eval stamp to this file when the run passes: the hash of the prompt and tools, the provider, model and tally. Anthropic or OpenAI’s own API only, every question, the default threshold or above',
    },
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
      const runs = runsOf(args.runs)
      if (runs === undefined) throw new EvalRefused('--runs takes a whole number of at least 1')
      const stampFile =
        typeof args.stamp === 'string' && args.stamp !== '' ? resolve(args.stamp) : undefined
      const fileRefused = stampFile === undefined ? undefined : stampFileRefusal(stampFile)
      if (fileRefused !== undefined) throw new EvalRefused(fileRefused)
      const project = await loadProject()
      const ai = project.config.commerce.ai
      if (ai.provider === 'none')
        throw new EvalRefused('no AI provider: set ai in nymbal.config.ts')
      if (stampFile !== undefined) {
        const { customerData, mask } = project.config.agents.assistant
        const refused = stampRunRefusal({
          ai,
          only: typeof args.only === 'string' ? args.only : undefined,
          threshold,
          customerData,
          mask,
        })
        if (refused !== undefined) throw new EvalRefused(refused)
      }
      const reports: GoldenReport[] = []
      let hash = ''
      for (let run = 1; run <= runs; run += 1) {
        if (runs > 1 && !args.json) process.stdout.write(`run ${run}/${runs}\n`)
        const evaluated = await evaluate(project, {
          only: typeof args.only === 'string' ? args.only : undefined,
          json: args.json,
          verbose: args.verbose,
        })
        reports.push(evaluated.report)
        hash = evaluated.hash
        if (runs > 1 && !args.json) {
          process.stdout.write(
            `${tokensLine(`tokens run ${run}/${runs}`, evaluated.report.usage)}\n`,
          )
        }
      }
      const tally = tallyGolden(reports)
      const usage = totalOf(reports.map((r) => r.usage))
      const stamp =
        stampFile === undefined
          ? undefined
          : stampOf({
              hash,
              provider: ai.provider,
              models: reports.flatMap((r) => r.models),
              tally,
              threshold,
              date: new Date(),
            })
      if (stampFile !== undefined && stamp !== undefined) {
        writeFileSync(stampFile, `${JSON.stringify(stamp, null, 2)}\n`)
      }
      const stamped =
        stampFile === undefined
          ? []
          : [
              stamp === undefined
                ? `stamp not written: ${tally.passed}/${tally.total} is under the threshold ${threshold}`
                : `stamp written: ${stampFile}`,
            ]
      out = process.stdout
      text = args.json
        ? JSON.stringify(
            {
              runs: tally.runs,
              passed: tally.passed,
              total: tally.total,
              threshold,
              hash,
              usage,
              questions: tally.questions,
              reports,
            },
            null,
            2,
          )
        : [
            ...(runs > 1
              ? tally.questions.map((q) => `tally ${q.id} ${q.passed}/${tally.runs}`)
              : []),
            `assistant eval: ${tally.passed}/${tally.total} passed (threshold ${threshold})`,
            injectionTally(tally),
            tokensLine('tokens', usage),
            ...stamped,
          ].join('\n')
      code = tally.passed >= threshold ? 0 : 1
    } catch (error) {
      if (!(error instanceof EvalRefused) && !(error instanceof GoldenAdapterError)) throw error
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
