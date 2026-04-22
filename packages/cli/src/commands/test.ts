import { defineCommand } from 'citty'
import { loadConfig } from '@nymbal/config'
import { run, runOrFail } from '../utils/spawn.js'

export const testCommand = defineCommand({
  meta: { name: 'test', description: 'Run unit + integration tests (vitest)' },
  async run() {
    await runOrFail('pnpm', ['vitest', 'run'])
  },
})

export const testE2eCommand = defineCommand({
  meta: { name: 'test:e2e', description: 'Run Playwright E2E against the configured template' },
  async run() {
    const { config } = await loadConfig()
    await runOrFail('pnpm', ['playwright', 'test', '--project', config.template])
  },
})

export const testVisualCommand = defineCommand({
  meta: { name: 'test:visual', description: 'Run visual regression tests (Playwright toHaveScreenshot)' },
  args: {
    'update-baselines': {
      type: 'boolean',
      description: 'Regenerate screenshot baselines',
      default: false,
    },
  },
  async run({ args }) {
    const { config } = await loadConfig()
    const pwArgs = ['playwright', 'test', '--project', config.template, '--grep', '@visual']
    if (args['update-baselines']) pwArgs.push('--update-snapshots')
    await runOrFail('pnpm', pwArgs)
  },
})

export const testContractsCommand = defineCommand({
  meta: { name: 'test:contracts', description: 'Run adapter contract tests' },
  args: {
    adapter: { type: 'string', description: 'Run only contracts for a specific adapter' },
  },
  async run({ args }) {
    const vArgs = ['vitest', 'run', 'tests/contracts']
    if (args.adapter) vArgs.push('--testNamePattern', String(args.adapter))
    await runOrFail('pnpm', vArgs)
  },
})

export const testPerformanceCommand = defineCommand({
  meta: { name: 'test:performance', description: 'Run Lighthouse CI against the configured template' },
  async run() {
    await runOrFail('pnpm', ['lhci', 'autorun'])
  },
})

export const testAllCommand = defineCommand({
  meta: { name: 'test:all', description: 'Run unit, contract, e2e, visual, and performance tests' },
  async run() {
    const steps: Array<{ name: string; args: string[] }> = [
      { name: 'unit', args: ['vitest', 'run'] },
      { name: 'contracts', args: ['vitest', 'run', 'tests/contracts'] },
    ]
    for (const step of steps) {
      const { done } = run('pnpm', step.args)
      const code = await done
      if (code !== 0) {
        // eslint-disable-next-line no-console
        console.error(`✗ ${step.name} failed`)
        process.exit(code)
      }
    }
    const { config } = await loadConfig()
    await runOrFail('pnpm', ['playwright', 'test', '--project', config.template])
    await runOrFail('pnpm', ['lhci', 'autorun'])
  },
})
