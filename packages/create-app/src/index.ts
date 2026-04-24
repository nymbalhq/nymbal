import { cp, readFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { cancel, confirm, intro, isCancel, note, outro, select, text } from '@clack/prompts'
import pc from 'picocolors'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCAFFOLD_ROOT = resolve(HERE, '..', 'scaffold')

export type PackageManager = 'npm' | 'pnpm' | 'yarn-classic' | 'yarn-berry' | 'bun'

interface Answers {
  name: string
  directory: string
  currency: 'GBP' | 'USD' | 'EUR'
  template: 'astro' | 'nextjs'
  seedDemo: boolean
  includeMobile: boolean
}

export function detectPackageManager(): PackageManager {
  const ua = process.env['npm_config_user_agent']
  if (!ua) return 'npm'
  const token = ua.split(' ')[0] ?? ''
  const slash = token.indexOf('/')
  const pm = slash >= 0 ? token.slice(0, slash) : token
  const version = slash >= 0 ? token.slice(slash + 1) : ''
  if (pm === 'pnpm') return 'pnpm'
  if (pm === 'bun') return 'bun'
  if (pm === 'yarn') {
    const major = parseInt(version.split('.')[0] ?? '1', 10)
    return major < 2 ? 'yarn-classic' : 'yarn-berry'
  }
  return 'npm'
}

function installCmd(pm: PackageManager): [string, string[]] {
  switch (pm) {
    case 'pnpm': return ['pnpm', ['install']]
    case 'bun': return ['bun', ['install']]
    case 'yarn-classic':
    case 'yarn-berry': return ['yarn', ['install']]
    default: return ['npm', ['install']]
  }
}

function seedCmd(pm: PackageManager): [string, string[]] {
  switch (pm) {
    case 'pnpm': return ['pnpm', ['exec', 'nymbal', 'seed']]
    case 'bun': return ['bunx', ['nymbal', 'seed']]
    case 'yarn-classic': return ['yarn', ['run', 'nymbal', 'seed']]
    case 'yarn-berry': return ['yarn', ['exec', 'nymbal', 'seed']]
    default: return ['npx', ['nymbal', 'seed']]
  }
}

function devCmd(pm: PackageManager): string {
  switch (pm) {
    case 'pnpm': return 'pnpm dev'
    case 'bun': return 'bun dev'
    case 'yarn-classic':
    case 'yarn-berry': return 'yarn dev'
    default: return 'npm run dev'
  }
}

export async function main(): Promise<void> {
  const argvName = process.argv[2] && !process.argv[2]!.startsWith('-') ? process.argv[2] : undefined

  const pm = detectPackageManager()

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

  const shouldInstall = (await confirm({
    message: 'Install dependencies now?',
    initialValue: true,
  })) as boolean | symbol

  if (isCancel(shouldInstall)) return cancel('Cancelled')

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

  if (shouldInstall) {
    await installDeps(targetDir, pm)
    if (answers.seedDemo) {
      await runSeed(targetDir, pm)
    }
  }

  const cmd = devCmd(pm)
  const nextSteps = [
    `  ${pc.cyan('cd')} ${answers.directory}`,
  ]
  if (!shouldInstall) {
    const [ic] = installCmd(pm)
    nextSteps.push(`  ${pc.cyan(ic + ' install')}`)
  }
  nextSteps.push(`  ${pc.cyan(cmd)}`)

  outro([pc.green(`✓ Created ${answers.directory}`), '', ...nextSteps].join('\n'))
}

export async function scaffold(dir: string, answers: Answers): Promise<void> {
  // Copy the chosen template directly into dir (flat — no storefront/ subdirectory)
  await copyScaffoldDir(resolve(SCAFFOLD_ROOT, 'templates', answers.template), dir)

  // Write nymbal.config.ts (answers-dependent, so generated at runtime)
  await writeFile(resolve(dir, 'nymbal.config.ts'), renderConfig(answers), 'utf8')

  // Patch the copied package.json: set name to the project directory name
  await patchPackageJson(dir, answers.directory)
}

async function patchPackageJson(dir: string, name: string): Promise<void> {
  const pkgPath = resolve(dir, 'package.json')
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as Record<string, unknown>
  pkg['name'] = name
  pkg['private'] = true
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
}

async function copyScaffoldDir(src: string, dest: string): Promise<void> {
  if (!existsSync(src)) {
    throw new Error(`Scaffold directory not found: ${src}`)
  }
  await cp(src, dest, {
    recursive: true,
    filter: (source) => !source.endsWith('node_modules'),
  })
  await renameDotFiles(dest)
}

async function renameDotFiles(dir: string): Promise<void> {
  // Non-recursive: only rename _dot.* files at the project root.
  // All shared dotfiles (_dot.gitignore, _dot.env.example) live at template root.
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() && entry.name.startsWith('_dot.')) {
      const full = resolve(dir, entry.name)
      const renamed = resolve(dir, '.' + entry.name.slice(5))
      await writeFile(renamed, await readFile(full))
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

function defaultLocale(currency: Answers['currency']): string {
  return currency === 'USD' ? 'en-US' : 'en-GB'
}

function defaultTimezone(currency: Answers['currency']): string {
  return currency === 'USD' ? 'America/New_York' : 'Europe/London'
}

function escape(v: string): string {
  return v.replace(/'/g, "\\'")
}

function toDirectoryName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_ ]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

async function installDeps(dir: string, pm: PackageManager): Promise<void> {
  const [cmd, args] = installCmd(pm)
  note(pc.dim(`Running ${cmd} install (this may take a moment)...`), 'Installing')
  await runCmd(cmd, args, dir)
}

async function runSeed(dir: string, pm: PackageManager): Promise<void> {
  note(pc.dim('Seeding demo content...'), 'Seeding')
  const [cmd, args] = seedCmd(pm)
  await runCmd(cmd, args, dir)
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
