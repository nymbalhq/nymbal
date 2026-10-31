import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { findConfigFile, loadConfig, slotFolder, type NymbalConfig } from '@nymbalhq/config'
import { checkAdapterModule, resolveChoice } from '@nymbalhq/platform'
import type { Slot } from '@nymbalhq/types'
import { isInstalled } from '../recipes/holders.js'
import { slotNamed } from '../slot-names.js'

/** A reason `test:contracts --package` cannot run, printed as its one line. */
export class CertifyError extends Error {}

/** What a third-party adapter package may export beside `createAdapter`. */
interface ContractOptionsExport {
  /** The options `createAdapter` takes when no slot of the project names the package. */
  options?: unknown
  /** The options that build an adapter whose dependency cannot be reached: given, the downtime cases run. */
  unreachable?: unknown
  /** A primitive's kind (`documentStore`, `eventBus` or `media`); a commerce adapter says its own `kind`. */
  kind?: string
}

interface AdapterModule {
  createAdapter?: unknown
  contractOptions?: ContractOptionsExport
}

interface TaskLike {
  type: string
  mode?: string
  result?: { state?: string }
  tasks?: TaskLike[]
}

interface VitestLike {
  state: { getFiles(): TaskLike[]; getUnhandledErrors(): unknown[] }
  close(): Promise<void>
}

const firstLine = (text: string): string => text.split('\n')[0]!.trim()
const messageOf = (err: unknown): string =>
  firstLine(err instanceof Error ? err.message : String(err))

/** Where the project resolves `specifier`, as its own code would; a package it has not installed is the install line. */
function resolveFrom(project: string, specifier: string, name: string, install: string): string {
  try {
    return createRequire(join(project, 'package.json')).resolve(specifier)
  } catch (err) {
    if ((err as { code?: unknown }).code === 'MODULE_NOT_FOUND') {
      throw new CertifyError(`${name} is not installed in ${project}: ${install}`)
    }
    throw new CertifyError(`${name} could not be resolved from ${project}: ${messageOf(err)}`)
  }
}

interface SlotBlock {
  provider: string
  package?: string | undefined
  config?: Record<string, unknown> | undefined
}

/** Every slot of the config with its block: the commerce slots, the infrastructure blocks, and security. */
function slotBlocks(config: NymbalConfig): Array<[Slot, SlotBlock]> {
  const { commerce, infrastructure, security } = config
  // `orders` sits beside the slots and is settings, not a slot.
  const slots = Object.entries(commerce).filter(([name]) => name !== 'orders')
  return [
    ...(slots as Array<[Slot, SlotBlock]>),
    ['documentStore', infrastructure.documentStore],
    ['eventBus', infrastructure.eventBus],
    ['media', infrastructure.media],
    [
      'security',
      { provider: security.adapter, package: security.package, config: security.config },
    ],
  ]
}

/**
 * The project's slot that loads `pkg`, as the kernel resolves it: its `package` names it (on a `custom` slot too), or
 * its convention name is it. Undefined when the project has no config or no slot names the package.
 */
export async function pickSlot(
  project: string,
  pkg: string,
  slot: string | undefined,
): Promise<{ slot: Slot; block: SlotBlock } | undefined> {
  if (findConfigFile(project) === null) return undefined
  let config: NymbalConfig
  try {
    config = (await loadConfig(project)).config
  } catch (err) {
    throw new CertifyError(`the project's config could not be loaded: ${messageOf(err)}`)
  }
  const naming = slotBlocks(config).filter(([name, block]) => {
    const resolved = resolveChoice(name, block)
    return block.package === pkg || (resolved.kind === 'package' && resolved.package === pkg)
  })
  const wanted = slot === undefined ? undefined : slotNamed(slot)
  const picked = slot === undefined ? naming : naming.filter(([name]) => name === wanted)
  if (slot !== undefined && picked.length === 0) {
    throw new CertifyError(`no slot '${slot}' loads ${pkg}`)
  }
  if (picked.length > 1) {
    throw new CertifyError(
      `${pkg} is named by the ${picked.map(([name]) => slotFolder(name)).join(', ')} slots: pick one with --slot`,
    )
  }
  const found = picked[0]
  return found === undefined ? undefined : { slot: found[0], block: found[1] }
}

/**
 * `value` with every own key whose value is `undefined` dropped, at any depth: an unset optional
 * (`apiKey: process.env.ACME_KEY`) is absent, as JSON leaves it. Anything but a plain object or array, and a cycle, is
 * kept as it is, for survivesJson to refuse.
 */
function withoutUndefined(value: unknown, path: Set<object> = new Set()): unknown {
  if (value === null || typeof value !== 'object' || path.has(value)) return value
  const proto = Object.getPrototypeOf(value) as unknown
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return value
  path.add(value)
  const out = Array.isArray(value)
    ? value.map((item) => withoutUndefined(item, path))
    : Object.fromEntries(
        Object.entries(value)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, withoutUndefined(v, path)]),
      )
  path.delete(value)
  return out
}

/** Whether a JSON round-trip gives `value` back unchanged; a value JSON cannot write (a BigInt, a cycle) does not. */
function survivesJson(value: unknown): boolean {
  try {
    return isDeepStrictEqual(JSON.parse(JSON.stringify(value)), value)
  } catch {
    return false
  }
}

async function closeProbe(adapter: unknown): Promise<void> {
  const close = (adapter as { close?: unknown } | null)?.close
  if (typeof close === 'function') await (close as () => Promise<void>).call(adapter)
}

function countCases(files: TaskLike[]): { passed: number; failed: number } {
  let passed = 0
  let failed = 0
  const visit = (task: TaskLike) => {
    if (task.type === 'test') {
      if (task.result?.state === 'pass') passed += 1
      else if (task.mode !== 'skip' && task.mode !== 'todo') failed += 1
    }
    for (const child of task.tasks ?? []) visit(child)
  }
  for (const file of files) visit(file)
  return { passed, failed }
}

/**
 * Certifies `pkg`, an adapter package installed in the project: builds it from the config of the project's slot that
 * names it, and runs the published suite for its kind with the project's own vitest. Returns the exit code.
 */
export async function certifyPackage(input: {
  pkg: string
  slot?: string
  cwd: string
}): Promise<number> {
  const { pkg, slot } = input
  const config = findConfigFile(input.cwd)
  const project = realpathSync(config === null ? resolve(input.cwd) : dirname(config))

  const vitestNode = resolveFrom(project, 'vitest/node', 'vitest', 'npm install --save-dev vitest')
  // The suites' vitest-free entry: the suites themselves import vitest, which throws outside a test run.
  const kindsEntry = resolveFrom(
    project,
    '@nymbalhq/contract-tests/kinds',
    '@nymbalhq/contract-tests',
    'npm install --save-dev @nymbalhq/contract-tests',
  )
  if (!isInstalled(pkg, project)) {
    throw new CertifyError(`${pkg} is not installed in ${project}: npm install ${pkg}`)
  }

  const contracts = join(project, '.nymbal', 'contracts')
  const slug = pkg.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')
  mkdirSync(contracts, { recursive: true })
  // Imported from inside the project, so Node resolves the package from the project's node_modules, as vitest will.
  const shim = join(contracts, `${slug}.adapter.mjs`)
  writeFileSync(shim, `export * from ${JSON.stringify(pkg)}\n`)
  let mod: AdapterModule
  try {
    mod = (await import(pathToFileURL(shim).href)) as AdapterModule
  } catch (err) {
    throw new CertifyError(`${pkg} could not be loaded: ${messageOf(err)}`)
  }
  const picked = await pickSlot(project, pkg, slot)
  if (picked !== undefined) {
    // The kernel's own check on load: a module for another slot or provider would never run there.
    try {
      checkAdapterModule(mod, picked.slot, picked.block.provider, pkg)
    } catch (err) {
      throw new CertifyError(messageOf(err))
    }
  } else if (typeof mod.createAdapter !== 'function') {
    throw new CertifyError(`${pkg} exports no createAdapter(options) function to certify`)
  }
  const createAdapter = mod.createAdapter as (options: unknown) => unknown
  const extra = mod.contractOptions ?? {}
  const slotConfig = picked === undefined ? undefined : (picked.block.config ?? {})
  const fromSlot =
    slotConfig === undefined ? undefined : (withoutUndefined(slotConfig) as Record<string, unknown>)
  const options = fromSlot ?? extra.options ?? {}
  // The generated file carries the slot's record as JSON, so a record JSON changes would certify another adapter.
  if (fromSlot !== undefined && !survivesJson(fromSlot)) {
    throw new CertifyError(
      `the config of the slot naming ${pkg} holds a value JSON cannot carry (a function, Date, BigInt or cycle): certify it with plain data`,
    )
  }

  let kind: string | undefined
  try {
    const probe = await createAdapter(options)
    const own = (probe as { kind?: unknown } | null)?.kind
    kind = typeof own === 'string' ? own : extra.kind
    await closeProbe(probe)
  } catch (err) {
    throw new CertifyError(`createAdapter from ${pkg} threw: ${messageOf(err)}`)
  }
  if (kind === undefined) {
    throw new CertifyError(
      `${pkg}'s adapter has no kind: a primitive names its own in contractOptions.kind`,
    )
  }
  const { CONTRACT_KINDS } = (await import(pathToFileURL(kindsEntry).href)) as {
    CONTRACT_KINDS: readonly string[]
  }
  if (!CONTRACT_KINDS.includes(kind)) {
    throw new CertifyError(
      `no contract suite for kind '${kind}' (${pkg}); the kinds with one are ${CONTRACT_KINDS.join(', ')}`,
    )
  }

  const file = `${slug}.contract.test.mjs`
  writeFileSync(
    join(contracts, file),
    [
      `// Written by \`nymbal test:contracts --package ${pkg}\`, and again on every run.`,
      `import * as adapter from ${JSON.stringify(pkg)}`,
      `import { contractSuites } from '@nymbalhq/contract-tests'`,
      ``,
      fromSlot === undefined
        ? `const options = adapter.contractOptions?.options ?? {}`
        : `const options = ${JSON.stringify(fromSlot)}`,
      `const unreachable = adapter.contractOptions?.unreachable`,
      ``,
      `async function build(config) {`,
      `  const built = await adapter.createAdapter(config)`,
      `  if (typeof built?.initialize === 'function') await built.initialize(config)`,
      `  return built`,
      `}`,
      ``,
      `contractSuites[${JSON.stringify(kind)}](${JSON.stringify(pkg)}, () => build(options), {`,
      `  ...(unreachable !== undefined && { unreachable: () => build(unreachable) }),`,
      `})`,
      ``,
    ].join('\n'),
  )

  const { startVitest } = (await import(pathToFileURL(vitestNode).href)) as {
    startVitest: (
      mode: 'test',
      filters: string[],
      options: Record<string, unknown>,
      vite: Record<string, unknown>,
    ) => Promise<VitestLike | undefined>
  }
  // No project config: a vitest.config of the store's own cannot hide or reshape the suite, and the cache stays here.
  const vitest = await startVitest(
    'test',
    [],
    {
      config: false,
      root: contracts,
      include: [file],
      watch: false,
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
    { cacheDir: join(contracts, '.vite') },
  )
  if (vitest === undefined) throw new CertifyError(`vitest did not start for ${pkg}`)
  const files = vitest.state.getFiles()
  const { passed, failed } = countCases(files)
  // A file that failed outside its cases (collection, a hook) or an unhandled error certifies nothing either.
  const broken =
    files.some((f) => f.result?.state === 'fail') || vitest.state.getUnhandledErrors().length > 0
  await vitest.close()

  const total = passed + failed
  if (failed === 0 && total > 0 && !broken) {
    process.stdout.write(`certified ${pkg} (${kind}): ${passed} cases passed\n`)
    return 0
  }
  process.stdout.write(`not certified ${pkg} (${kind}): ${failed} of ${total} cases failed\n`)
  return 1
}
