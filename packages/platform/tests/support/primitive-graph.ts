import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { install, workspace } from '../../../../tests/support/project.js'

// Runs fixtures/primitive-graph/child.mjs (createApp from the built dist, every resolution recorded with its
// importer) and reads back what it resolved and what it reported. Needs `pnpm build`.

const exec = promisify(execFile)
const CHILD = fileURLToPath(
  new URL('../integration/fixtures/primitive-graph/child.mjs', import.meta.url),
)

export interface Resolution {
  specifier: string
  parent: string | null
  url: string
}

export interface SlotReport {
  provider: string
  capabilities: string[]
}

export interface GraphOutcome {
  started?: {
    report: { documentStore: SlotReport; eventBus: SlotReport }
    own: { documentStore: string[]; eventBus: string[] }
    probed: string[]
  }
  error?: { name?: string; code?: string; message: string }
}

/** The primitive packages, by directory under packages/. */
export const PRIMITIVE_PACKAGES = [
  'adapters/document-store/redis',
  'adapters/document-store/postgres-jsonb',
  'adapters/event-bus/redis-streams',
] as const

/** A URL inside the workspace package `dir` (packages/<dir>/, at any depth), not a copy under node_modules/.pnpm. */
export const inPackage = (url: string, dir: string): boolean =>
  url.includes(`/packages/${dir}/`) && !url.includes('/node_modules/.pnpm/')
export const underModule = (url: string, name: string): boolean =>
  url.includes(`/node_modules/${name}/`)

const dirs: string[] = []
export function cleanupGraphDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'primitives-graph-test-'))
  dirs.push(dir)
  return dir
}

/** A kernel config with its infrastructure replaced; parsed, so the schema's defaults apply. */
export function withInfrastructure(
  config: NymbalConfig,
  infrastructure: Record<string, unknown>,
): NymbalConfig {
  return nymbalConfigSchema.parse({ ...config, infrastructure })
}

export async function runGraphChild(
  config: NymbalConfig,
  /**
   * `env` is laid over the child's environment; a variable set to undefined is removed from it. `installed` names the
   * workspace packages the child's project (its working directory) holds; the kernel resolves adapters from there.
   */
  opts: { hide?: string[]; env?: Record<string, string | undefined>; installed?: string[] } = {},
): Promise<{ resolutions: Resolution[]; outcome: GraphOutcome }> {
  const dir = scratch()
  install(dir, workspace(...(opts.installed ?? [])))
  const out = join(dir, 'resolved.jsonl')
  writeFileSync(out, '')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PRIMITIVES_GRAPH: JSON.stringify({ out, hide: opts.hide }),
  }
  delete env['npm_config_user_agent']
  for (const [name, value] of Object.entries(opts.env ?? {})) {
    if (value === undefined) delete env[name]
    else env[name] = value
  }
  const { stdout } = await exec(process.execPath, [CHILD, JSON.stringify(config)], {
    cwd: dir,
    env,
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  const line = stdout.split('\n').find((l) => l.startsWith('PRIMITIVE-GRAPH-OUTCOME '))
  if (line === undefined) throw new Error(`the child printed no outcome:\n${stdout}`)
  return {
    resolutions: readFileSync(out, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Resolution),
    outcome: JSON.parse(line.slice('PRIMITIVE-GRAPH-OUTCOME '.length)) as GraphOutcome,
  }
}
