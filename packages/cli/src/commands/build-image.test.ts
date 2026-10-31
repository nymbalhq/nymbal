import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, matchesGlob } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cliEnv, runCli } from '../../../../tests/support/doctor.js'
import { storeConfig, storeProject } from '../../../../tests/support/start.js'

// AC-7, the command's half: `nymbal build --image` writes a Dockerfile (installing with the manager package.json
// records) and a .dockerignore that keeps .env files, databases, node_modules and build output out of the image, then
// runs `docker build` in the project tagged `<package name>:latest` or --tag; a Dockerfile already there is used as
// it is. `docker` is a recorder on PATH. The image itself is proved by tests/scaffold-image. Spawns the built CLI.

const FROZEN: Record<string, string> = {
  npm: 'npm ci',
  pnpm: 'pnpm install --frozen-lockfile',
}
const LOCKFILE: Record<string, string> = { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml' }

let cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

/** A project as create-nymbal-app leaves it for `manager`, with a recording `docker` first on PATH. */
function imageProject(manager: string) {
  const project = storeProject(storeConfig())
  cleanup.push(() => project.remove())
  writeFileSync(
    join(project.dir, 'package.json'),
    JSON.stringify({
      name: 'shop',
      private: true,
      type: 'module',
      packageManager: `${manager}@10.9.0`,
    }),
  )
  writeFileSync(
    join(project.dir, LOCKFILE[manager]!),
    manager === 'npm' ? '{}' : 'lockfileVersion: 9.0\n',
  )
  writeFileSync(join(project.dir, '.env'), `NYMBAL_SECRETS_KEY=${'k'.repeat(43)}=\n`)
  const bin = join(project.dir, 'path-bin')
  mkdirSync(bin)
  const log = join(project.dir, 'docker.log')
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\nprintf '%s|%s\\n' "$(pwd -P)" "$*" >> '${log}'\n`)
  chmodSync(join(bin, 'docker'), 0o755)
  const env = cliEnv({ PATH: `${bin}:/usr/bin:/bin` })
  const calls = () =>
    (existsSync(log) ? readFileSync(log, 'utf8') : '')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        const [cwd, args] = line.split('|') as [string, string]
        return { cwd, args: args.split(' ') }
      })
  return { dir: project.dir, env, calls }
}

/** The name in the project's package.json. */
function packageName(dir: string): string {
  return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string }).name
}

/** The tag a `docker build` call gives with -t or --tag. */
function tagOf(args: string[]): string | undefined {
  const at = args.findIndex((a) => a === '-t' || a === '--tag')
  return at >= 0 ? args[at + 1] : args.find((a) => a.startsWith('--tag='))?.slice('--tag='.length)
}

describe('AC-7: nymbal build --image', () => {
  for (const manager of ['pnpm', 'npm']) {
    it(`AC-7: in a ${manager} project with no Dockerfile it writes one that installs with ${FROZEN[manager]}, a .dockerignore that keeps .env*, *.db, node_modules and dist out, and runs docker build in the project tagged shop:latest`, async () => {
      const { dir, env, calls } = imageProject(manager)

      const run = await runCli(['build', '--image'], { cwd: dir, env })
      const dockerfile = existsSync(join(dir, 'Dockerfile'))
        ? readFileSync(join(dir, 'Dockerfile'), 'utf8')
        : ''
      const ignore = existsSync(join(dir, '.dockerignore'))
        ? readFileSync(join(dir, '.dockerignore'), 'utf8')
            .split('\n')
            .map((l) => l.trim().replace(/^\//, ''))
            .filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith('!'))
        : []
      const kept = [
        '.env',
        '.env.local',
        '.env.production',
        'nymbal.db',
        'shop.db',
        'node_modules',
        'dist',
      ].filter(
        (path) =>
          !ignore.some(
            (pattern) => matchesGlob(path, pattern) || matchesGlob(path, `${pattern}/**`),
          ),
      )
      const builds = calls().filter(
        (c) => c.args[0] === 'build' || (c.args[0] === 'buildx' && c.args[1] === 'build'),
      )

      expect(run.code, run.out).toBe(0)
      expect(dockerfile).toContain(FROZEN[manager])
      expect(
        Object.values(FROZEN).filter((cmd) => cmd !== FROZEN[manager] && dockerfile.includes(cmd)),
      ).toEqual([])
      expect(kept).toEqual([])
      expect(builds).toHaveLength(1)
      expect(tagOf(builds[0]!.args)).toBe(`${packageName(dir)}:latest`)
      expect(builds[0]!.cwd === dir || builds[0]!.args.includes(dir)).toBe(true)
    }, 60_000)
  }

  it('AC-7: --tag names the image, and a Dockerfile already in the project is used as it is', async () => {
    const { dir, env, calls } = imageProject('pnpm')
    const own = 'FROM node:26.12.1-slim\n# the store owner wrote this\nCMD ["node", "server.js"]\n'
    writeFileSync(join(dir, 'Dockerfile'), own)

    const run = await runCli(['build', '--image', '--tag', 'acme/shop:2'], { cwd: dir, env })
    const builds = calls().filter((c) => c.args.includes('build'))

    expect(run.code, run.out).toBe(0)
    expect(readFileSync(join(dir, 'Dockerfile'), 'utf8')).toBe(own)
    expect(run.out).toMatch(/Dockerfile/)
    expect(builds.map((c) => tagOf(c.args))).toEqual(['acme/shop:2'])
  }, 60_000)
})
