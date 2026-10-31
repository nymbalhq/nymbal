import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { renderDockerfile } from './dockerfile.js'

// AC-12: the image's Dockerfile installs with the package manager the project records, at its recorded version and
// frozen to its lockfile, and runs `nymbal start` as PID 1 in exec form on the project's Node, as a non-root user.

const FROZEN = {
  npm: 'npm ci',
  pnpm: 'pnpm install --frozen-lockfile',
  yarn: 'yarn install --immutable',
  bun: 'bun install --frozen-lockfile',
} as const
type Manager = keyof typeof FROZEN
const COREPACK = 'npm install -g corepack@0.36.0'
const LINKER = 'nodeLinker: node-modules'

/** The Dockerfile's instructions, one per entry, with `\`-continued lines joined. */
function instructions(dockerfile: string): string[] {
  return dockerfile
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

/** The instructions after the last FROM: the runtime stage. */
function runtimeStage(dockerfile: string): string[] {
  const all = instructions(dockerfile)
  const last = all.map((line) => /^FROM\s/i.test(line)).lastIndexOf(true)
  return all.slice(last)
}

/** The image a FROM line names, with the `ARG name=value` defaults declared before the first FROM substituted. */
function fromImage(dockerfile: string, from: string): string {
  const args = new Map<string, string>()
  for (const line of instructions(dockerfile)) {
    if (/^FROM\s/i.test(line)) break
    const m = /^ARG\s+([A-Za-z_][A-Za-z0-9_]*)=(\S+)$/i.exec(line)
    if (m) args.set(m[1]!, m[2]!.replace(/^["']|["']$/g, ''))
  }
  const image = from.replace(/^FROM\s+(--\S+\s+)*/i, '').split(/\s+/)[0] ?? ''
  return image.replace(
    /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g,
    (_, name: string) => args.get(name) ?? '',
  )
}

const version = fc
  .tuple(fc.nat({ max: 30 }), fc.nat({ max: 40 }), fc.nat({ max: 40 }))
  .map((parts) => parts.join('.'))
const nodeVersion = fc
  .tuple(fc.integer({ min: 22, max: 30 }), fc.nat({ max: 20 }), fc.nat({ max: 20 }))
  .map((parts) => parts.join('.'))
const template = fc.constantFrom('astro' as const, 'nextjs' as const)

/** A recorded package manager and version, yarn split into its classic (1) and berry (2 and later) lines. */
const recorded = fc.oneof(
  fc.record({ manager: fc.constantFrom<Manager>('npm', 'pnpm', 'bun'), version }),
  fc.record({
    manager: fc.constant<Manager>('yarn'),
    version: fc.tuple(fc.nat({ max: 22 }), fc.nat({ max: 22 })).map(([a, b]) => `1.${a}.${b}`),
  }),
  fc.record({
    manager: fc.constant<Manager>('yarn'),
    version: fc
      .tuple(fc.integer({ min: 2, max: 6 }), fc.nat({ max: 20 }), fc.nat({ max: 20 }))
      .map((parts) => parts.join('.')),
  }),
)

describe('AC-12: renderDockerfile per package manager', () => {
  it('AC-12: npm, pnpm and yarn get their manager through corepack@0.36.0 and bun through bun@<recorded>, before the one frozen install of the recorded manager; no npm install -g yarn line', () => {
    fc.assert(
      fc.property(recorded, nodeVersion, template, ({ manager, version: v }, node, t) => {
        const text = renderDockerfile({
          packageManager: `${manager}@${v}`,
          nodeVersion: node,
          template: t,
        })
        const installs = (Object.keys(FROZEN) as Manager[]).filter((m) => text.includes(FROZEN[m]))

        const steps = [
          ...(manager === 'bun' ? [`npm install -g bun@${v}`] : [COREPACK, 'corepack enable']),
          FROZEN[manager],
        ]
        const offsets = steps.map((step) => text.indexOf(step))

        expect(installs).toEqual([manager])
        expect(text).not.toMatch(/npm install -g yarn@/)
        expect(offsets.filter((at) => at < 0)).toEqual([])
        expect(offsets).toEqual([...offsets].sort((a, b) => a - b))
      }),
      { numRuns: 200 },
    )
  })

  it('AC-12: a recorded yarn 2 or later writes nodeLinker: node-modules before its install, and yarn 1 and every other manager do not', () => {
    fc.assert(
      fc.property(recorded, nodeVersion, template, ({ manager, version: v }, node, t) => {
        const text = renderDockerfile({
          packageManager: `${manager}@${v}`,
          nodeVersion: node,
          template: t,
        })
        const berry = manager === 'yarn' && Number(v.split('.')[0]) >= 2

        expect(text.includes(LINKER)).toBe(berry)
        expect(berry ? text.indexOf(LINKER) < text.indexOf(FROZEN.yarn) : true).toBe(true)
      }),
      { numRuns: 200 },
    )
  })

  it('AC-12: the runtime stage is a later stage on the recorded Node, runs as a non-root user, exposes 3001, and its CMD is the exec-form node node_modules/nymbal/bin/nymbal.mjs start', () => {
    fc.assert(
      fc.property(recorded, nodeVersion, template, ({ manager, version: v }, node, t) => {
        const text = renderDockerfile({
          packageManager: `${manager}@${v}`,
          nodeVersion: node,
          template: t,
        })
        const stages = instructions(text).filter((line) => /^FROM\s/i.test(line))
        const runtime = runtimeStage(text)
        const user = runtime
          .filter((line) => /^USER\s/i.test(line))
          .map((line) => line.split(/\s+/)[1])
        const cmd = runtime.filter((line) => /^CMD\s/i.test(line))

        expect(stages.length).toBeGreaterThanOrEqual(2)
        expect(fromImage(text, runtime[0]!).startsWith(`node:${node}`)).toBe(true)
        expect(fromImage(text, runtime[0]!).slice(`node:${node}`.length)).toMatch(/^($|[-@])/)
        expect(user.length).toBe(1)
        expect(['root', '0', '0:0', 'root:root']).not.toContain(user[0])
        expect(runtime.filter((line) => /^EXPOSE\s+3001(\/tcp)?$/i.test(line))).toHaveLength(1)
        expect(cmd).toHaveLength(1)
        expect(JSON.parse(cmd[0]!.replace(/^CMD\s+/i, ''))).toEqual([
          'node',
          'node_modules/nymbal/bin/nymbal.mjs',
          'start',
        ])
      }),
      { numRuns: 100 },
    )
  })

  it('AC-12: the build stage runs the frozen install before nymbal build', () => {
    for (const manager of Object.keys(FROZEN) as Manager[]) {
      const v = manager === 'yarn' ? '4.10.3' : '1.2.3'
      const text = renderDockerfile({
        packageManager: `${manager}@${v}`,
        nodeVersion: '26.12.1',
        template: 'astro',
      })
      const build = instructions(text).findIndex((line) => /nymbal(\.mjs)?\s+build\b/.test(line))
      const install = instructions(text).findIndex((line) => line.includes(FROZEN[manager]))

      expect(build, text).toBeGreaterThan(install)
      expect(install, text).toBeGreaterThanOrEqual(0)
    }
  })
})
