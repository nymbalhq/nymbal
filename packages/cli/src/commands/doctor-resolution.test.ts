import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nymbalConfigSchema } from '@nymbalhq/config'
import repoConfig from '../../../../nymbal.config.js'
import { installLine } from '../../../platform/src/adapters/index.js'
import {
  cliEnv,
  doctorLines,
  expectedCheckNames,
  migratedSqlite,
  REPO_ROOT,
  runCli,
  type CliRun,
} from '../../../../tests/support/doctor.js'
import { INSTALL_VERB } from '../../../../tests/support/module-hooks.js'
import { install, workspace } from '../../../../tests/support/project.js'

// AC-9: `nymbal doctor` resolves each slot by the kernel's rule. `package <slot>` is ok naming the package for a
// convention provider and for a `package:` one; a typo is down with the suggestion and no install verb; a missing
// catalogue package is down with the install line. The infrastructure slots and security report the same way. Each
// project's node_modules holds what its case installs: a workspace adapter, or a third party's fixture package; a
// missing package is one it does not hold (tests/support/project.ts). Spawns the built CLI (`pnpm build` first).

const SEARCH_FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'third-party-search')
const MEDIA_FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'third-party-media')

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nymbal-doctor-resolution-'))
})
afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

interface Doctored extends CliRun {
  project: string
  env: NodeJS.ProcessEnv
  raw: Record<string, unknown>
}

async function doctor(
  edit: {
    infrastructure: Record<string, unknown>
    security?: Record<string, unknown>
    commerce?: Record<string, unknown>
  },
  installed: Record<string, string>,
): Promise<Doctored> {
  const project = mkdtempSync(join(dir, 'project-'))
  install(project, installed)
  const raw = {
    ...repoConfig,
    infrastructure: edit.infrastructure,
    security: { ...repoConfig.security, ...edit.security },
    commerce: { ...repoConfig.commerce, ...edit.commerce },
  }
  writeFileSync(
    join(project, 'nymbal.config.ts'),
    `export default ${JSON.stringify(raw, null, 2)}\n`,
  )
  const sqlitePath = join(project, 'nymbal.db')
  await migratedSqlite(sqlitePath)
  const env = cliEnv({
    NYMBAL_SQLITE_PATH: sqlitePath,
    npm_config_user_agent: undefined,
  })
  return { ...(await runCli(['doctor'], { cwd: project, env })), project, env, raw }
}

const line = (run: CliRun, name: string) => doctorLines(run.out).find((l) => l.name === name)

describe('AC-9: doctor reports each slot as the kernel resolves it', () => {
  let run: Doctored

  beforeAll(async () => {
    run = await doctor(
      {
        infrastructure: {
          commandStore: 'sqlite',
          documentStore: { provider: 'reddis' },
          eventBus: { provider: 'in-process' },
          media: {
            provider: 'acme',
            package: '@acme/nymbal-media',
            config: { publicUrl: 'https://media.acme.test' },
          },
        },
        security: { adapter: 'cloudfare' },
        commerce: {
          payments: { provider: 'stripe', config: { secretKey: 'sk_test_doctor_resolution' } },
          search: { provider: 'acme', package: '@acme/nymbal-search' },
          email: { provider: 'smpt' },
        },
      },
      {
        '@acme/nymbal-search': SEARCH_FIXTURE,
        '@acme/nymbal-media': MEDIA_FIXTURE,
        ...workspace('@nymbalhq/payments-stripe'),
      },
    )
  }, 90_000)

  it('AC-9: package payments is ok naming @nymbalhq/payments-stripe, the convention package', () => {
    expect(line(run, 'config')?.status, run.out.slice(-3000)).toBe('ok')
    expect(line(run, 'package payments')).toEqual({
      status: 'ok',
      name: 'package payments',
      detail: expect.stringContaining('@nymbalhq/payments-stripe'),
    })
  })

  it('AC-9: package search and package media are ok naming the package: one, @acme/nymbal-search and @acme/nymbal-media', () => {
    expect(line(run, 'package search')).toEqual({
      status: 'ok',
      name: 'package search',
      detail: expect.stringContaining('@acme/nymbal-search'),
    })
    expect(line(run, 'package media')).toEqual({
      status: 'ok',
      name: 'package media',
      detail: expect.stringContaining('@acme/nymbal-media'),
    })
    expect(line(run, 'package search')?.detail).not.toContain('@nymbalhq/search-acme')
  })

  it('AC-9: a typo on a commerce slot, an infrastructure slot and security is down with the suggestion and no install verb', () => {
    const typos = [
      ['package email', 'smtp'],
      ['package documentStore', 'redis'],
      ['package security', 'cloudflare'],
    ] as const
    for (const [name, suggestion] of typos) {
      const found = line(run, name)
      expect(found?.status, `${name}: ${run.out.slice(-3000)}`).toBe('down')
      expect(found?.detail, name).toContain(`did you mean '${suggestion}'`)
      expect(found?.detail, name).not.toMatch(INSTALL_VERB)
    }
    expect(run.code).toBe(1)
  })

  it('AC-9: the check names are the ones the config gives: a package line for every slot that resolves to a package', () => {
    const names = doctorLines(run.out)
      .map((l) => l.name)
      .sort()
    expect(names).toEqual(expectedCheckNames(nymbalConfigSchema.parse(run.raw)))
  })
})

describe('AC-9: a missing catalogue package is down with the install line', () => {
  it('AC-9: documentStore redis with @nymbalhq/document-store-redis not installed: package documentStore is down with the install line of the package and ioredis', async () => {
    const run = await doctor(
      {
        infrastructure: {
          commandStore: 'sqlite',
          documentStore: { provider: 'redis' },
          eventBus: { provider: 'in-process' },
          // Never connected to: the package is missing before any connection is made.
          redis: { url: 'redis://127.0.0.1:1', prefix: 'doctor-resolution' },
        },
      },
      {},
    )
    const pkg = line(run, 'package documentStore')

    expect(run.code, run.out.slice(-3000)).toBe(1)
    expect(pkg?.status).toBe('down')
    expect(pkg?.detail).toContain(
      installLine(['@nymbalhq/document-store-redis', 'ioredis'], run.env, run.project),
    )
  }, 90_000)
})
