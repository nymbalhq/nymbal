import { cp, readFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
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
}

/**
 * Runs a command in `cwd` (with `env` when given, else the process environment) and rejects on a non-zero exit.
 * Injected into `main` so tests do not shell out.
 */
export type Runner = (
  cmd: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
) => Promise<void>

/** The port `renderConfig` gives the API, which serves the admin at /admin/. */
const API_PORT = 3001

interface AdminCredentials {
  email: string
  password: string
}

/** A fresh admin password per project (128 bits, base64url), so no two stores share the seed's default. */
function newAdminCredentials(): AdminCredentials {
  return { email: 'admin@nymbal.local', password: randomBytes(16).toString('base64url') }
}

/**
 * `.env` holds the admin credentials the seed (and a first `nymbal dev`) creates the admin from, and the project's own
 * key for the values the admin's Settings encrypt (32 random bytes, base64).
 */
async function writeAdminEnv(dir: string, admin: AdminCredentials): Promise<void> {
  const lines = [
    '# The admin account the seed creates. Keep this file out of version control (.gitignore lists it).',
    `NYMBAL_ADMIN_EMAIL=${admin.email}`,
    `NYMBAL_ADMIN_PASSWORD=${admin.password}`,
    '',
    "# Encrypts the keys saved in the admin's Settings. Losing it loses them: back it up with your deploy's secrets.",
    `NYMBAL_SECRETS_KEY=${randomBytes(32).toString('base64')}`,
    '',
  ]
  await writeFile(resolve(dir, '.env'), lines.join('\n'), { encoding: 'utf8', mode: 0o600 })
}

function adminSignIn(admin: AdminCredentials): string[] {
  return [
    `Admin: http://localhost:${API_PORT}/admin/`,
    `  email     ${admin.email}`,
    `  password  ${admin.password} (saved in .env)`,
  ]
}

export interface MainDeps {
  run?: Runner
}

/**
 * The `packageManager` field for the package manager that launched us (`npm_config_user_agent`), read when called.
 * Without a usable user agent it is the installed npm; undefined when npm cannot be run either.
 */
function packageManagerField(): string | undefined {
  const token = (process.env['npm_config_user_agent'] ?? '').split(' ')[0] ?? ''
  const match = /^(npm|pnpm|yarn|bun)\/(\d+\.\d+\.\d+\S*)$/.exec(token)
  if (match) return `${match[1]}@${match[2]}`
  const npm = spawnSync('npm', ['-v'], { encoding: 'utf8', shell: process.platform === 'win32' })
  const version = npm.status === 0 ? npm.stdout.trim() : ''
  return version ? `npm@${version}` : undefined
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
    case 'pnpm':
      return ['pnpm', ['install']]
    case 'bun':
      return ['bun', ['install']]
    case 'yarn-classic':
    case 'yarn-berry':
      return ['yarn', ['install']]
    default:
      return ['npm', ['install']]
  }
}

function seedCmd(pm: PackageManager): [string, string[]] {
  switch (pm) {
    case 'pnpm':
      return ['pnpm', ['exec', 'nymbal', 'seed']]
    case 'bun':
      return ['bunx', ['nymbal', 'seed']]
    case 'yarn-classic':
      return ['yarn', ['run', 'nymbal', 'seed']]
    case 'yarn-berry':
      return ['yarn', ['exec', 'nymbal', 'seed']]
    default:
      return ['npx', ['nymbal', 'seed']]
  }
}

function devCmd(pm: PackageManager): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm dev'
    case 'bun':
      return 'bun dev'
    case 'yarn-classic':
    case 'yarn-berry':
      return 'yarn dev'
    default:
      return 'npm run dev'
  }
}

const TEMPLATES = ['astro', 'nextjs'] as const
const CURRENCIES = ['GBP', 'USD', 'EUR'] as const

export interface CliFlags {
  name?: string
  template?: (typeof TEMPLATES)[number]
  currency?: (typeof CURRENCIES)[number]
  yes: boolean
  /** Present (false) only with `--no-install`. */
  install?: boolean
}

/** A command-line flag that is missing its value or names a value outside the allowed set. */
export class CliFlagError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliFlagError'
  }
}

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(value)) return value as T
  throw new CliFlagError(`Unknown ${flag} "${value}". Allowed: ${allowed.join(', ')}`)
}

/** Parses process.argv (node and script first): --name, --template and --currency take `--flag v` or `--flag=v`. */
export function parseCliFlags(argv: string[]): CliFlags {
  const flags: CliFlags = { yes: false }
  const args = argv.slice(2)
  let positional: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--yes' || arg === '-y') {
      flags.yes = true
      continue
    }
    if (arg === '--no-install') {
      flags.install = false
      continue
    }
    const match = /^--(name|template|currency)(?:=(.*))?$/s.exec(arg)
    if (match) {
      const flag = match[1]!
      let value = match[2]
      if (value === undefined) {
        const next = args[i + 1]
        if (next === undefined || next.startsWith('-'))
          throw new CliFlagError(`--${flag} needs a value`)
        value = next
        i++
      }
      if (flag === 'name') flags.name = value
      else if (flag === 'template') flags.template = oneOf('--template', value, TEMPLATES)
      else flags.currency = oneOf('--currency', value, CURRENCIES)
    } else if (!arg.startsWith('-') && positional === undefined) {
      positional = arg
    }
  }
  if (flags.name === undefined && positional !== undefined) flags.name = positional
  return flags
}

export async function main(argv: string[] = process.argv, deps: MainDeps = {}): Promise<void> {
  const run = deps.run ?? runCmd
  let flags: CliFlags
  try {
    flags = parseCliFlags(argv)
  } catch (err) {
    if (!(err instanceof CliFlagError)) throw err
    process.stderr.write(`Error: ${err.message}\n`)
    process.exit(1)
  }

  const pm = detectPackageManager()

  if (flags.yes) {
    if (!flags.name) {
      process.stderr.write('Error: --yes requires --name or a positional name argument\n')
      process.exit(1)
    }
    const name = flags.name.trim()
    const answers: Answers = {
      name,
      directory: toDirectoryName(name),
      currency: flags.currency ?? 'GBP',
      template: flags.template ?? 'astro',
      seedDemo: true,
    }
    const targetDir = resolve(process.cwd(), answers.directory)
    if (existsSync(targetDir)) {
      const entries = await readdir(targetDir)
      if (entries.length > 0) {
        process.stderr.write(
          `Error: Directory ${answers.directory} already exists and is not empty.\n`,
        )
        process.exit(1)
      }
    } else {
      await mkdir(targetDir, { recursive: true })
    }
    await scaffold(targetDir, answers)
    const admin = newAdminCredentials()
    await writeAdminEnv(targetDir, admin)
    process.stdout.write(`Created ${answers.directory}\n`)
    if (flags.install !== false) {
      await installAndSeed(targetDir, pm, answers.seedDemo, run, admin)
    } else {
      process.stdout.write(`Next: cd ${answers.directory} && ${installCmd(pm)[0]} install\n`)
    }
    process.stdout.write(`${adminSignIn(admin).join('\n')}\n`)
    return
  }

  intro(pc.cyan(pc.bold('◆ create-nymbal-app')))

  const name = flags.name
    ? flags.name
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

  const shouldInstall =
    flags.install === false
      ? false
      : ((await confirm({
          message: 'Install dependencies now?',
          initialValue: true,
        })) as boolean | symbol)

  if (isCancel(shouldInstall)) return cancel('Cancelled')

  const answers: Answers = {
    name: String(name).trim(),
    directory: toDirectoryName(String(name).trim()),
    currency: currency as 'GBP' | 'USD' | 'EUR',
    template: template as 'astro' | 'nextjs',
    seedDemo: seedDemo as boolean,
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
  const admin = newAdminCredentials()
  await writeAdminEnv(targetDir, admin)

  if (shouldInstall) {
    await installAndSeed(targetDir, pm, answers.seedDemo, run, admin)
  }

  const cmd = devCmd(pm)
  const nextSteps = [`  ${pc.cyan('cd')} ${answers.directory}`]
  if (!shouldInstall) {
    const [ic] = installCmd(pm)
    nextSteps.push(`  ${pc.cyan(ic + ' install')}`)
  }
  nextSteps.push(`  ${pc.cyan(cmd)}`)

  outro(
    [pc.green(`✓ Created ${answers.directory}`), '', ...nextSteps, '', ...adminSignIn(admin)].join(
      '\n',
    ),
  )
}

/** Install with the detected package manager, then seed through the project's own `nymbal` bin. */
async function installAndSeed(
  dir: string,
  pm: PackageManager,
  seedDemo: boolean,
  run: Runner,
  admin: AdminCredentials,
): Promise<void> {
  const [installBin, installArgs] = installCmd(pm)
  process.stdout.write(`Running ${installBin} install (this may take a moment)...\n`)
  await run(installBin, installArgs, dir)
  if (seedDemo) {
    process.stdout.write('Seeding demo content...\n')
    const [seedBin, seedArgs] = seedCmd(pm)
    // Explicit, so a value exported in the shell cannot replace the one in .env and the outro.
    await run(seedBin, seedArgs, dir, {
      ...process.env,
      NYMBAL_ADMIN_EMAIL: admin.email,
      NYMBAL_ADMIN_PASSWORD: admin.password,
    })
  }
}

export async function scaffold(dir: string, answers: Answers): Promise<void> {
  // Copy the chosen template directly into dir (flat — no storefront/ subdirectory)
  await copyScaffoldDir(resolve(SCAFFOLD_ROOT, 'templates', answers.template), dir)

  // Overlay the project layer (scaffold/project/<template>) on top of the template
  // defaults. Project files WIN on path collision — this is the override model:
  // anything in the project layer shadows the template default at the same path.
  // scaffold/project/ lives outside scaffold/templates/, so sync-scaffold's
  // rm -rf of scaffold/templates/* never deletes it.
  const projectLayer = resolve(SCAFFOLD_ROOT, 'project', answers.template)
  if (existsSync(projectLayer)) {
    await copyScaffoldDir(projectLayer, dir)
  }

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
  const packageManager = packageManagerField()
  if (packageManager) pkg['packageManager'] = packageManager
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
  return `import { defineConfig } from '@nymbalhq/config'

export default defineConfig({
  store: {
    name: '${escape(answers.name)}',
    currency: '${answers.currency}',
    locale: '${defaultLocale(answers.currency)}',
    timezone: '${defaultTimezone(answers.currency)}',
  },

  template: '${answers.template}',

  infrastructure: {
    commandStore: 'sqlite',
    documentStore: 'in-memory',
    eventBus: 'in-process',
  },

  security: {
    adapter: 'middleware',
    rateLimit: {
      '/checkout': { requests: 10, window: '1m', action: 'block' },
      '/auth/*': { requests: 5, window: '1m', action: 'challenge' },
      '/api/*': { requests: 100, window: '1m', action: 'throttle' },
      '/webhooks/*': { requests: 200, window: '1m', action: 'throttle' },
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
    payments: { provider: 'native' },
    email: { provider: 'native' },
    reviews: { provider: 'native' },
    search: { provider: 'native' },
    analytics: { provider: 'native' },
    shipping: { provider: 'native' },
    tax: { provider: 'native' },
    ai: { provider: 'none' },
  },

  http: {
    adapter: 'fastify',
    port: ${API_PORT},
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

const runCmd: Runner = (cmd, args, cwd, env = process.env) => {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: 'inherit', shell: false })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) return resolve()
      reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}`))
    })
  })
}
