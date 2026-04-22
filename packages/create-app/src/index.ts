import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { cancel, confirm, intro, isCancel, note, outro, select, text } from '@clack/prompts'
import pc from 'picocolors'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCAFFOLD_ROOT = resolve(HERE, '..', 'scaffold')

interface Answers {
  name: string
  directory: string
  currency: 'GBP' | 'USD' | 'EUR'
  template: 'astro' | 'nextjs'
  seedDemo: boolean
  includeMobile: boolean
}

async function main(): Promise<void> {
  const argvName = process.argv[2] && !process.argv[2]!.startsWith('-') ? process.argv[2] : undefined

  intro(pc.cyan(pc.bold('◆ create-nymbal-app')))

  const name = argvName
    ? argvName
    : ((await text({
        message: 'Store name',
        placeholder: 'My Store',
        validate: (v) => (!v || v.trim().length === 0 ? 'Required' : undefined),
      })) as string | symbol)

  if (isCancel(name)) return cancel('Cancelled')

  type Currency = 'GBP' | 'USD' | 'EUR'
  const currencyOptions: { value: Currency; label: string }[] = [
    { value: 'GBP', label: 'GBP — British Pound' },
    { value: 'USD', label: 'USD — US Dollar' },
    { value: 'EUR', label: 'EUR — Euro' },
  ]
  const currency = await select({
    message: 'Store currency',
    options: currencyOptions,
    initialValue: 'GBP' as Currency,
  })

  if (isCancel(currency)) return cancel('Cancelled')

  type Template = 'astro' | 'nextjs'
  const templateOptions: { value: Template; label: string }[] = [
    { value: 'astro', label: 'Astro (recommended — performance-first)' },
    { value: 'nextjs', label: 'Next.js (migration-friendly)' },
  ]
  const template = await select({
    message: 'Storefront template',
    options: templateOptions,
    initialValue: 'astro' as Template,
  })

  if (isCancel(template)) return cancel('Cancelled')

  const seedDemo = (await confirm({
    message: 'Generate demo content?',
    initialValue: true,
  })) as boolean | symbol

  if (isCancel(seedDemo)) return cancel('Cancelled')

  const includeMobile = (await confirm({
    message: 'Include mobile app? (placeholder for v1.0)',
    initialValue: false,
  })) as boolean | symbol

  if (isCancel(includeMobile)) return cancel('Cancelled')

  const answers: Answers = {
    name: String(name).trim(),
    directory: toDirectoryName(String(name).trim()),
    currency: currency as 'GBP' | 'USD' | 'EUR',
    template: template as 'astro' | 'nextjs',
    seedDemo: seedDemo as boolean,
    includeMobile: includeMobile as boolean,
  }

  const targetDir = resolve(process.cwd(), answers.directory)
  if (existsSync(targetDir)) {
    const entries = await readdir(targetDir)
    if (entries.length > 0) {
      cancel(`Directory ${answers.directory} already exists and is not empty.`)
      process.exit(1)
    }
  } else {
    await mkdir(targetDir, { recursive: true })
  }

  note(pc.dim(`Scaffolding into ${targetDir}`), 'Creating project')

  await scaffold(targetDir, answers)
  await installDeps(targetDir)
  if (answers.seedDemo) {
    await runSeed(targetDir)
  }

  outro(
    [
      pc.green(`✓ Created ${answers.directory}`),
      '',
      `  ${pc.cyan('cd')} ${answers.directory}`,
      `  ${pc.cyan('nymbal')} dev`,
    ].join('\n'),
  )
}

function toDirectoryName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_ ]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

async function scaffold(dir: string, answers: Answers): Promise<void> {
  // 1) Copy base scaffold.
  await copyScaffoldDir(resolve(SCAFFOLD_ROOT, 'base'), dir)
  // 2) Copy only the chosen template.
  await copyScaffoldDir(resolve(SCAFFOLD_ROOT, 'templates', answers.template), resolve(dir, 'storefront'))

  // 3) Write nymbal.config.ts
  const configTs = renderConfig(answers)
  await writeFile(resolve(dir, 'nymbal.config.ts'), configTs, 'utf8')

  // 4) Write root package.json
  const pkg = renderRootPackage(answers)
  await writeFile(resolve(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8')

  // 5) Write pnpm workspace
  await writeFile(
    resolve(dir, 'pnpm-workspace.yaml'),
    'packages:\n  - "storefront"\n',
    'utf8',
  )

  // 6) .env.example
  await writeFile(
    resolve(dir, '.env.example'),
    [
      '# Copy to .env and fill in as needed',
      'NYMBAL_API_URL=http://localhost:3001',
      '# DATABASE_URL=postgres://user:pass@localhost:5432/nymbal',
      '# STRIPE_SECRET_KEY=',
      '# STRIPE_WEBHOOK_SECRET=',
      '# ANTHROPIC_API_KEY=',
      '',
    ].join('\n'),
    'utf8',
  )
}

async function copyScaffoldDir(src: string, dest: string): Promise<void> {
  if (!existsSync(src)) {
    throw new Error(`Scaffold directory not found: ${src}`)
  }
  await cp(src, dest, {
    recursive: true,
    filter: (source) => !source.endsWith('node_modules'),
  })
  // Rename any _gitignore / _dot files.
  await renameDotFiles(dest)
}

async function renameDotFiles(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      await renameDotFiles(full)
    } else if (entry.name.startsWith('_dot.')) {
      const renamed = resolve(dir, '.' + entry.name.slice(5))
      const content = await readFile(full)
      await writeFile(renamed, content)
      await rm(full)
    }
  }
}

function renderConfig(answers: Answers): string {
  return `import { defineConfig, env } from '@nymbal/config'

export default defineConfig({
  store: {
    name: '${escape(answers.name)}',
    currency: '${answers.currency}',
    locale: '${defaultLocale(answers.currency)}',
    timezone: '${defaultTimezone(answers.currency)}',
  },

  template: '${answers.template}',

  infrastructure: {
    cloud: 'local',
    commandStore: 'sqlite',
    documentStore: 'in-memory',
    eventBus: 'in-process',
    compute: 'in-process',
  },

  security: {
    adapter: 'middleware',
    rateLimit: {
      '/checkout': { requests: 10, window: '60s', action: 'block' },
      '/auth/*': { requests: 5, window: '60s', action: 'challenge' },
      '/api/*': { requests: 100, window: '60s', action: 'throttle' },
      '/webhooks/*': { requests: 200, window: '60s', action: 'throttle' },
    },
    botProtection: { mode: 'managed', allowList: ['googlebot', 'bingbot', 'stripe-webhooks'] },
    headers: {
      hsts: true,
      contentSecurityPolicy: 'strict',
      referrerPolicy: 'strict-origin-when-cross-origin',
      xFrameOptions: 'deny',
    },
    csrf: true,
  },

  commerce: {
    payments: {
      provider: 'stripe',
      config: {
        secretKey: env('STRIPE_SECRET_KEY', 'sk_test_placeholder'),
        webhookSecret: env('STRIPE_WEBHOOK_SECRET', 'whsec_placeholder'),
      },
    },
    email: { provider: 'native' },
    reviews: { provider: 'native' },
    search: { provider: 'native' },
    analytics: { provider: 'native' },
    shipping: { provider: 'native' },
    tax: { provider: 'native' },
    ai: { provider: 'anthropic', config: { apiKey: env('ANTHROPIC_API_KEY', 'anthropic-placeholder') } },
  },

  http: {
    adapter: 'fastify',
    port: 3001,
  },

  deployment: {
    strategy: 'standard',
  },

  features: {
    staging: false,
    heartbeat: false,
    autoUpdates: false,
  },
})
`
}

function renderRootPackage(answers: Answers): Record<string, unknown> {
  return {
    name: answers.directory,
    version: '0.1.0',
    private: true,
    type: 'module',
    engines: { node: '>=22' },
    packageManager: 'pnpm@9.12.3',
    scripts: {
      dev: 'nymbal dev',
      build: 'nymbal build',
      migrate: 'nymbal migrate',
      seed: 'nymbal seed',
    },
    dependencies: {
      '@nymbal/config': 'workspace:*',
      '@nymbal/platform': 'workspace:*',
      '@nymbal/cli': 'workspace:*',
      '@nymbal/types': 'workspace:*',
      [`@nymbal/template-${answers.template}`]: 'workspace:*',
    },
  }
}

function defaultLocale(currency: Answers['currency']): string {
  return currency === 'USD' ? 'en-US' : currency === 'EUR' ? 'en-GB' : 'en-GB'
}

function defaultTimezone(currency: Answers['currency']): string {
  return currency === 'USD' ? 'America/New_York' : 'Europe/London'
}

function escape(v: string): string {
  return v.replace(/'/g, "\\'")
}

async function installDeps(dir: string): Promise<void> {
  note(pc.dim('Running pnpm install (this may take a moment)...'), 'Installing')
  await runCmd('pnpm', ['install'], dir)
}

async function runSeed(dir: string): Promise<void> {
  note(pc.dim('Seeding demo content...'), 'Seeding')
  // Use pnpm exec to find the workspace-linked nymbal CLI.
  await runCmd('pnpm', ['exec', 'nymbal', 'seed'], dir)
}

function runCmd(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: false })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) return resolve()
      reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}`))
    })
  })
}

// Silence unused-var lint for helper retained for future use.
void stat

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(pc.red('✗ create-nymbal-app failed'))
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
