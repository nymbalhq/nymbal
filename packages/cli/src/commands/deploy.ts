import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { defineCommand } from 'citty'
import pc from 'picocolors'
import { DEFAULT_JWT_SECRET, type NymbalConfig } from '@nymbalhq/config'
import { loadProject } from '../utils/project.js'

export interface DeployProject {
  /** The app's name on the platform. */
  name: string
  root: string
  config: NymbalConfig
}

const NYMBAL = 'node node_modules/nymbal/bin/nymbal.mjs'
/** Above `nymbal start`'s default NYMBAL_SHUTDOWN_MS (10 s), so the drain finishes before the platform kills. */
const KILL_TIMEOUT_S = 15
/** Where a step's secret comes from; a dry run prints it, a live run puts the value from .env in its place. */
const FROM_ENV = '<from .env>'

function usesPostgres(config: NymbalConfig): boolean {
  return config.infrastructure.commandStore === 'postgres'
}

function usesRedis(config: NymbalConfig): boolean {
  return (
    config.infrastructure.documentStore.provider === 'redis' ||
    config.infrastructure.eventBus.provider === 'redis-streams'
  )
}

/**
 * What the config must change before its image can run in production, where the app refuses the stub payments and
 * the schema's JWT secret. Each is a step a live run stops at (`<…>`): the config is code, built into the image.
 */
function prerequisites(config: NymbalConfig): string[] {
  return [
    ...(config.commerce.payments.provider === 'native'
      ? [
          '<first: configure a real payments provider (nymbal add stripe); production refuses the native stub>',
        ]
      : []),
    ...(config.security.auth.jwtSecret === DEFAULT_JWT_SECRET
      ? [
          '<first: set security.auth.jwtSecret in nymbal.config.ts to a secret of your own; production refuses the default>',
        ]
      : []),
  ]
}

export function flyRecipe(project: DeployProject): { file: string; toml: string; steps: string[] } {
  const { name, config } = project
  const toml = [
    `app = "${name}"`,
    `kill_signal = "SIGTERM"`,
    `kill_timeout = ${KILL_TIMEOUT_S}`,
    '',
    '[build]',
    '  dockerfile = "Dockerfile"',
    '',
    '[deploy]',
    `  release_command = "${NYMBAL} migrate"`,
    '',
    '[env]',
    `  NYMBAL_PUBLIC_URL = "https://${name}.fly.dev"`,
    '',
    '[http_service]',
    '  internal_port = 3001',
    '  force_https = true',
    '',
    '  [[http_service.checks]]',
    '    method = "GET"',
    '    path = "/ready"',
    '    interval = "15s"',
    '    timeout = "6s"',
    '    grace_period = "20s"',
    '',
  ].join('\n')
  const steps = [
    ...prerequisites(config),
    `flyctl apps create ${name}`,
    ...(usesPostgres(config)
      ? [
          `flyctl postgres create --name ${name}-db`,
          `flyctl postgres attach ${name}-db --app ${name}`,
        ]
      : []),
    ...(usesRedis(config)
      ? [
          `flyctl redis create --name ${name}-redis`,
          `flyctl secrets set REDIS_URL=<from flyctl redis status ${name}-redis> --app ${name} --stage`,
        ]
      : []),
    `flyctl secrets set NYMBAL_SECRETS_KEY=${FROM_ENV} --app ${name} --stage`,
    `flyctl deploy --app ${name}`,
  ]
  return { file: join(project.root, 'fly.toml'), toml, steps }
}

export function railwayRecipe(project: DeployProject): {
  file: string
  json: string
  steps: string[]
} {
  const { name, config } = project
  const json = `${JSON.stringify(
    {
      $schema: 'https://railway.com/railway.schema.json',
      build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
      deploy: {
        preDeployCommand: [`${NYMBAL} migrate`],
        startCommand: `${NYMBAL} start`,
        healthcheckPath: '/ready',
        drainingSeconds: KILL_TIMEOUT_S,
        restartPolicyType: 'ON_FAILURE',
      },
    },
    null,
    2,
  )}\n`
  const service = `--service ${name}`
  const steps = [
    ...prerequisites(config),
    `railway init --name ${name}`,
    ...(usesPostgres(config) ? ['railway add --database postgres'] : []),
    ...(usesRedis(config) ? ['railway add --database redis'] : []),
    `railway add ${service}`,
    ...(usesPostgres(config)
      ? [`railway variables ${service} --set 'DATABASE_URL=\${{Postgres.DATABASE_URL}}'`]
      : []),
    ...(usesRedis(config)
      ? [`railway variables ${service} --set 'REDIS_URL=\${{Redis.REDIS_URL}}'`]
      : []),
    `railway variables ${service} --set 'NYMBAL_PUBLIC_URL=https://\${{RAILWAY_PUBLIC_DOMAIN}}'`,
    `railway variables ${service} --set NYMBAL_SECRETS_KEY=${FROM_ENV}`,
    `railway domain ${service}`,
    `railway up ${service}`,
  ]
  return { file: join(project.root, 'railway.json'), json, steps }
}

/** Whether `command` is an executable file on PATH; looks only at the filesystem. */
function onPath(command: string): boolean {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue
    try {
      accessSync(join(dir, command), constants.X_OK)
      return true
    } catch {
      // not in this directory
    }
  }
  return false
}

/** The app name from package.json: a platform name is lowercase letters, digits and dashes. */
function appName(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string }
  const name = (pkg.name ?? '')
    .replace(/^@/, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (name === '') throw new Error('package.json needs a "name" to name the app')
  return name
}

/** The live run: each step as printed, with `<from .env>` filled from the project's .env and nothing printed of it. */
function runSteps(steps: string[], tool: string): void {
  for (const step of steps) {
    // eslint-disable-next-line no-console
    console.log(pc.dim(`$ ${step}`))
    const unresolved = /<(?!from \.env>)[^>]+>/.exec(step)
    if (unresolved) {
      process.stderr.write(
        `${pc.yellow(`Finish from here by hand: this step needs ${unresolved[0]}.`)}\n`,
      )
      process.exit(1)
    }
    const argv = (step.match(/'[^']*'|\S+/g) ?? []).map((part) =>
      part.startsWith("'") ? part.slice(1, -1) : part,
    )
    const filled = argv.map((part) => {
      const at = part.indexOf(FROM_ENV)
      if (at < 0) return part
      const key = part.slice(0, at - 1)
      const value = process.env[key]
      if (value === undefined || value === '') {
        process.stderr.write(`${pc.red(`${key} is not set in .env`)}\n`)
        process.exit(1)
      }
      return `${key}=${value}`
    })
    const done = spawnSync(filled[0]!, filled.slice(1), { stdio: 'inherit' })
    if (done.status !== 0) {
      process.stderr.write(`${pc.red(`${tool} step failed: ${step}`)}\n`)
      process.exit(1)
    }
  }
}

function platformCommand(platform: 'fly' | 'railway') {
  const tool = platform === 'fly' ? 'flyctl' : 'railway'
  return defineCommand({
    meta: {
      name: platform,
      description: `Write ${platform === 'fly' ? 'fly.toml' : 'railway.json'} and deploy with ${tool}`,
    },
    args: {
      dryRun: {
        type: 'boolean',
        alias: 'dry-run',
        description: 'Write the recipe and print the steps; run nothing',
        default: false,
      },
    },
    async run({ args }) {
      const { config, projectRoot } = await loadProject()
      if (!args.dryRun && !onPath(tool)) {
        process.stderr.write(
          `${pc.red(`${tool} is not on PATH.`)} Install it and log in, or run with --dry-run to see the steps.\n`,
        )
        process.exit(1)
      }
      const project = { name: appName(projectRoot), root: projectRoot, config }
      const recipe = platform === 'fly' ? flyRecipe(project) : railwayRecipe(project)
      const content = 'toml' in recipe ? recipe.toml : recipe.json
      if (!existsSync(join(projectRoot, 'Dockerfile'))) {
        // eslint-disable-next-line no-console
        console.log(pc.yellow('No Dockerfile yet: `nymbal build --image` writes one.'))
      }
      writeFileSync(recipe.file, content)
      // eslint-disable-next-line no-console
      console.log(`✓ wrote ${recipe.file}`)
      if (args.dryRun) {
        // eslint-disable-next-line no-console
        console.log(`\nThe steps, with ${tool}:\n${recipe.steps.map((s) => `  ${s}`).join('\n')}`)
        return
      }
      const whoami = spawnSync(tool, platform === 'fly' ? ['auth', 'whoami'] : ['whoami'], {
        stdio: 'ignore',
      })
      if (whoami.status !== 0) {
        process.stderr.write(
          `${pc.red(`${tool} is not logged in.`)} Run \`${tool === 'flyctl' ? 'flyctl auth login' : 'railway login'}\` first.\n`,
        )
        process.exit(1)
      }
      runSteps(recipe.steps, tool)
    },
  })
}

export const deployCommand = defineCommand({
  meta: { name: 'deploy', description: 'Deploy the store to Fly or Railway' },
  subCommands: {
    fly: platformCommand('fly'),
    railway: platformCommand('railway'),
  },
})
