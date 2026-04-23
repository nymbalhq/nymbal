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
    await runOrFail('pnpm', [
      '--filter', '@nymbal/e2e', 'exec',
      'playwright', 'test', '--project', config.template, '--grep-invert', '@visual|@a11y',
    ])
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
    const isCI = !!process.env.CI
    const updateBaselines = args['update-baselines']

    if (updateBaselines && !isCI) {
      // Run in Docker for Linux-consistent baselines
      const dockerImage = 'mcr.microsoft.com/playwright:v1.50-jammy'
      const cwd = process.cwd()
      await runOrFail('docker', [
        'run', '--rm', '-v', `${cwd}:${cwd}`, '-w', cwd,
        dockerImage, 'sh', '-c',
        `pnpm --filter @nymbal/e2e exec playwright test --project ${config.template} --grep "@visual" --update-snapshots`,
      ])
    } else {
      const pwArgs = [
        '--filter', '@nymbal/e2e', 'exec',
        'playwright', 'test', '--project', config.template, '--grep', '@visual',
      ]
      if (updateBaselines) pwArgs.push('--update-snapshots')
      await runOrFail('pnpm', pwArgs)
    }
  },
})

export const testContractsCommand = defineCommand({
  meta: { name: 'test:contracts', description: 'Run adapter contract tests' },
  args: {
    adapter: { type: 'string', description: 'Run only contracts for a specific adapter (e.g. payments, email)' },
  },
  async run({ args }) {
    const vArgs = [
      'vitest', 'run',
      '--project', 'contracts-native',
    ]
    if (args.adapter) {
      // Pass the specific file path as additional argument
      vArgs.push(`tests/contracts/${String(args.adapter)}.test.ts`)
    }
    await runOrFail('pnpm', vArgs)
  },
})

export const testPerformanceCommand = defineCommand({
  meta: { name: 'test:performance', description: 'Run Lighthouse CI against the configured template' },
  async run() {
    const { config } = await loadConfig()
    const port = config.template === 'nextjs' ? 3000 : 4321
    await runOrFail('pnpm', ['lhci', 'autorun'], {
      env: {
        ...process.env,
        NYMBAL_TEMPLATE: config.template,
        NYMBAL_TEMPLATE_PORT: String(port),
      },
    })
  },
})

export const testAllCommand = defineCommand({
  meta: { name: 'test:all', description: 'Run unit, contract, e2e, visual, and performance tests' },
  async run() {
    const steps: Array<{ name: string; args: string[] }> = [
      { name: 'unit', args: ['vitest', 'run'] },
      { name: 'contracts', args: ['vitest', 'run', '--project', 'contracts-native'] },
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
    await runOrFail('pnpm', [
      '--filter', '@nymbal/e2e', 'exec',
      'playwright', 'test', '--project', config.template, '--grep-invert', '@visual|@a11y',
    ])
    await runOrFail('pnpm', [
      '--filter', '@nymbal/e2e', 'exec',
      'playwright', 'test', '--project', config.template, '--grep', '@visual',
    ])
    await runOrFail('pnpm', ['lhci', 'autorun'], {
      env: { ...process.env, NYMBAL_TEMPLATE: config.template },
    })
  },
})
