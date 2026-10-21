import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseEnv } from 'node:util'
import { defineCommand } from 'citty'
import pc from 'picocolors'
import { findConfigFile, loadConfig } from '@nymbalhq/config'
import { installLine } from '@nymbalhq/platform'
import type { Recipe } from '@nymbalhq/types'
import {
  RECIPE_HOLDERS,
  appendRecipeEnv,
  applyRecipeToConfig,
  envCalls,
  isInstalled,
  isKnownRecipe,
  knownRecipes,
  missingEnv,
  readRecipe,
  recipeFile,
  settingsEnv,
} from '../recipes/index.js'

export interface AddOptions {
  recipe: string
  install: boolean
  force: boolean
  dryRun: boolean
}

const out = (line = ''): void => void process.stdout.write(`${line}\n`)
const err = (line: string): void => void process.stderr.write(`${line}\n`)

function fail(message: string): number {
  err(pc.red(`✗ ${message}`))
  return 1
}

/** Runs an install line in the project, its output passed through; whether it succeeded. */
function runInstall(line: string, root: string): boolean {
  out(pc.dim(`$ ${line}`))
  const [command, ...args] = line.split(' ')
  const result = spawnSync(command!, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  return result.status === 0
}

/** The variables `.env` sets to something, which `nymbal dev` loads before the config. */
function dotEnv(root: string): Record<string, string> {
  const file = join(root, '.env')
  return existsSync(file) ? (parseEnv(readFileSync(file, 'utf8')) as Record<string, string>) : {}
}

const isSet = (name: string, fromFile: Record<string, string>): boolean =>
  (process.env[name] ?? '') !== '' || (fromFile[name] ?? '') !== ''

/**
 * Why the candidate config would not run, without connecting to anything: a recipe package the project does not
 * resolve, or a config `loadConfig` refuses (the schema and its cross-slot rules). The candidate is loaded as
 * `nymbal.config.ts` from a temp directory under the project, so `@nymbalhq/config` resolves as the real one does. For
 * that load only, every variable an `env()` call names takes its `.env` value as `nymbal dev` would, and one still
 * unset gets a placeholder unless its calls have a default, which is what runs.
 */
async function problemsWith(
  candidate: string,
  recipe: Recipe,
  root: string,
  fromFile: Record<string, string>,
): Promise<string[]> {
  const problems: string[] = []
  const missing = recipe.install.filter((pkg) => !isInstalled(pkg, root))
  if (missing.length > 0) {
    problems.push(
      `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not installed: ${installLine(missing, process.env, root)}`,
    )
  }
  const saved = new Map<string, string | undefined>()
  for (const { name, defaulted } of envCalls(candidate)) {
    if ((process.env[name] ?? '') !== '') continue
    const value = fromFile[name] || (defaulted ? undefined : `nymbal-add-placeholder-${name}`)
    if (value === undefined) continue
    saved.set(name, process.env[name])
    process.env[name] = value
  }
  const dir = mkdtempSync(join(root, '.nymbal-add-'))
  try {
    writeFileSync(join(dir, 'nymbal.config.ts'), candidate)
    await loadConfig(dir)
  } catch (error) {
    problems.push((error as Error).message)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  return problems
}

/** The lines of `after` that `before` lacks (`+`) and the reverse (`-`), by a longest common subsequence. */
function lineDiff(before: string, after: string): string[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      t[i]![j] = a[i] === b[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!)
  const lines: string[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++
      j++
    } else if (j < b.length && (i === a.length || t[i]![j + 1]! >= t[i + 1]![j]!)) {
      lines.push(pc.green(`+ ${b[j++]}`))
    } else {
      lines.push(pc.red(`- ${a[i++]}`))
    }
  }
  return lines
}

const show = (value: unknown): string =>
  typeof value === 'string' ? `'${value}'` : JSON.stringify(value)

export async function add(opts: AddOptions, cwd: string = process.cwd()): Promise<number> {
  const name = opts.recipe
  if (!isKnownRecipe(name)) {
    return fail(`unknown recipe '${name}'. The recipes are: ${knownRecipes().join(', ')}`)
  }
  const configPath = findConfigFile(cwd)
  if (configPath === null) return fail(`no nymbal.config.ts in ${cwd} or any parent directory`)
  const root = dirname(configPath)
  const holder = RECIPE_HOLDERS[name]!

  const installed: string[] = []
  if (recipeFile(name, root) === null) {
    const line = installLine([holder], process.env, root)
    if (!opts.install || opts.dryRun) {
      return fail(
        `the ${name} recipe ships in ${holder}, which is not installed. Install it: ${line}`,
      )
    }
    if (!runInstall(line, root)) return fail(`${line} failed`)
    installed.push(holder)
  }
  const recipe = await readRecipe(name, root)

  const source = readFileSync(configPath, 'utf8')
  let edited: { source: string; changed: string[] }
  try {
    const applied = applyRecipeToConfig(source, recipe, { force: opts.force })
    if ('conflict' in applied) {
      const { path, current, wanted } = applied.conflict
      return fail(
        `${path} is ${show(current)} in nymbal.config.ts, and the ${name} recipe sets it to ${show(wanted)}. ` +
          'nymbal.config.ts is unchanged: edit it by hand, or re-run with --force to overwrite it.',
      )
    }
    edited = applied
  } catch (error) {
    return fail((error as Error).message)
  }
  const examplePath = join(root, '.env.example')
  const example = existsSync(examplePath) ? readFileSync(examplePath, 'utf8') : ''
  const nextExample = appendRecipeEnv(example, recipe)

  if (opts.dryRun) {
    out(pc.bold(`nymbal add ${name} --dry-run: nothing is written`))
    out()
    out(
      recipe.install.length > 0
        ? `install: ${installLine(recipe.install, process.env, root)}`
        : 'install: nothing',
    )
    out()
    out('nymbal.config.ts:')
    const diff = lineDiff(source, edited.source)
    for (const line of diff.length > 0 ? diff : ['(already set)']) out(`  ${line}`)
    out()
    out('.env.example:')
    const added = nextExample
      .slice(example.length)
      .split(/\r?\n/)
      .filter((l) => l !== '')
    for (const line of added.length > 0 ? added : ['(every variable already listed)'])
      out(`  ${line}`)
    return 0
  }

  const pending = recipe.install.filter((pkg) => !isInstalled(pkg, root))
  if (pending.length > 0 && opts.install) {
    const line = installLine(pending, process.env, root)
    if (!runInstall(line, root)) return fail(`${line} failed`)
    installed.push(...pending)
  }

  const fromFile = dotEnv(root)
  const problems = await problemsWith(edited.source, recipe, root, fromFile)
  if (problems.length > 0) {
    return fail(
      `the ${name} recipe would leave a config that does not load, so nymbal.config.ts is unchanged:\n  ${problems.join('\n  ')}`,
    )
  }

  const written: string[] = []
  if (installed.length > 0) written.push(`package.json and its lockfile (${installed.join(', ')})`)
  if (edited.source !== source) {
    writeFileSync(configPath, edited.source)
    written.push(`nymbal.config.ts (${edited.changed.join(', ')})`)
  }
  if (nextExample !== example) {
    writeFileSync(examplePath, nextExample)
    written.push(
      `.env.example (${missingEnv(example, recipe)
        .map((v) => v.name)
        .join(', ')})`,
    )
  }

  out(pc.green(`✓ ${name}: ${recipe.summary}`))
  out(written.length > 0 ? `  changed ${written.join(', ')}` : '  already added: nothing changed')
  const unset = recipe.env.filter((v) => v.required && !isSet(v.name, fromFile))
  if (unset.length > 0 || recipe.next.length > 0) {
    out()
    out('Next:')
    const fromSettings = unset.length > 0 ? await settingsEnv(recipe.install, root) : new Set()
    for (const v of unset) {
      out(
        fromSettings.has(v.name)
          ? `  - set ${v.name} in .env or in the admin's Settings`
          : `  - set ${v.name} in .env`,
      )
    }
    for (const line of recipe.next) out(`  - ${line}`)
  }
  return 0
}

export const addCommand = defineCommand({
  meta: {
    name: 'add',
    description: `Put the store on a service: ${knownRecipes().join(', ')}`,
  },
  args: {
    recipe: { type: 'positional', required: true, description: knownRecipes().join(', ') },
    install: {
      type: 'boolean',
      default: true,
      description: 'Install the packages (--no-install: they must already be installed)',
    },
    force: {
      type: 'boolean',
      default: false,
      description: 'Overwrite a config value the recipe conflicts with',
    },
    'dry-run': {
      type: 'boolean',
      default: false,
      description:
        'Print the config change, the .env.example lines and the install line, and write nothing',
    },
  },
  async run({ args }) {
    process.exitCode = await add({
      recipe: args.recipe,
      install: args.install,
      force: args.force,
      dryRun: args['dry-run'],
    })
  },
})
