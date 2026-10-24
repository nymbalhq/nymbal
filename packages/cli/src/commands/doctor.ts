import { existsSync } from 'node:fs'
import { defineCommand } from 'citty'
import type { LoadedConfig } from '@nymbalhq/config'
import { createLogger, diagnose, type DiagnosisReport } from '@nymbalhq/platform'
import { errorText, HEALTH_CHECK_TIMEOUT_MS } from '@nymbalhq/types'
import { loadProject } from '../utils/project.js'
import { resolveMigrations } from './migrate.js'
import { formatDoctorReport } from './doctor-report.js'

function timeoutOf(flag: string | undefined): number {
  if (flag === undefined || flag.trim() === '') return HEALTH_CHECK_TIMEOUT_MS
  const ms = Number(flag)
  if (!Number.isInteger(ms) || ms < 1) {
    throw new Error(`--timeout must be a whole number of milliseconds, got "${flag}"`)
  }
  return ms
}

/**
 * The migrations `nymbal migrate` applies here, when it can find them; else diagnose reads those of the platform this
 * CLI runs, which are the ones its kernel expects.
 */
function migrationsOf(projectRoot: string): { migrationsRoot?: string } {
  const root = resolveMigrations(projectRoot)
  return existsSync(root) ? { migrationsRoot: root } : {}
}

export const doctorCommand = defineCommand({
  meta: {
    name: 'doctor',
    description:
      'Check the project without changing it: config, packages, command store, migrations, slots and primitives',
  },
  args: {
    json: { type: 'boolean', description: 'Print the checks as one JSON document', default: false },
    timeout: {
      type: 'string',
      description: `How long each check may take, in ms (default ${HEALTH_CHECK_TIMEOUT_MS})`,
    },
  },
  async run({ args }) {
    const timeoutMs = timeoutOf(args.timeout)
    let loaded: LoadedConfig | { error: unknown }
    try {
      loaded = await loadProject()
    } catch (error) {
      loaded = { error }
    }
    const report: DiagnosisReport =
      'error' in loaded
        ? // Nothing else can be checked without a config, so it is the only line.
          { checks: [{ name: 'config', status: 'down', detail: errorText(loaded.error) }] }
        : await diagnose(loaded.config, {
            ...(loaded.adapters !== undefined && { adapters: loaded.adapters }),
            // The report carries every failure; a log line would only repeat one, and break `--json`.
            logger: createLogger({ level: 'silent', pretty: false }),
            timeoutMs,
            ...migrationsOf(loaded.projectRoot),
          })
    const text = formatDoctorReport(report, {
      json: args.json,
      config: 'error' in loaded ? undefined : loaded.config,
      env: process.env,
    })
    const down = report.checks.some((check) => check.status === 'down')
    // A pipe on macOS is written asynchronously: exiting before the write lands would cut the report short.
    process.stdout.write(`${text}\n`, () => process.exit(down ? 1 : 0))
  },
})
