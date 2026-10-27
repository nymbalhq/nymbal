import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { mutateSet, strykerConfig } from './gate'

// The mutation ratchet: mutation-ratchet.json records each mutated file's best Stryker score, and a run that scores a
// file below its entry fails. `check` runs in gate:full after Stryker and `check --static` (entries against the
// mutate set, no report) in the plain gate; `update` raises entries and never lowers one: with `--total` every
// file, otherwise only the files changed since the base (`--base`, GATE_BASE, origin/dev) or named by `--files`,
// and files with no entry yet. `--config` names another Stryker config and `--ratchet` its own ratchet file
// (stryker.integration.config.mjs and mutation-ratchet.integration.json): the mutate set and the remedies follow them.
// Scores are percent with two decimals: (killed + timeout) / (killed + timeout + survived + noCoverage) × 100. A file
// whose detected mutants all timed out, none killed, is unmeasured: nothing shows a test saw any of them, so it
// scores 0 (it scored 100 before 2026-10-25), and `update` records that 0 over an entry that was never a measurement.
// `check --static` also names the mutate-set files with no unit test file beside them (only integration tests reach
// them), and, given a base, warns of a change to a measured file whose unit test file did not change: new code in a
// service with no unit test passed every local gate and failed the incremental Stryker run in CI.

export type Scores = Record<string, number>

export type Ratchet = { measuredAt: string; command: string; total: number; files: Scores }

type StrykerReport = { files?: Record<string, { mutants?: Array<{ status?: string }> }> }

export const DEFAULT_COMMAND = 'pnpm mutation --force'

const DEFAULT_CONFIG = 'stryker.config.mjs'
const DEFAULT_RATCHET = 'mutation-ratchet.json'
const DEFAULT_REPORT = 'reports/mutation/mutation.json'

/** The Stryker config whose mutate set the ratchet follows, and how the printed remedies name it. */
type Target = {
  config: string
  /** `--config` and `--ratchet` as the remedies pass them: empty for the defaults, which print as before. */
  flags: string
  /** The report the config's run writes. */
  report: string
  /** The Stryker command for that config, ending where `--mutate` follows. */
  stryker: string
}

async function target(config: string, ratchet: string): Promise<Target> {
  const custom = config !== DEFAULT_CONFIG || ratchet !== DEFAULT_RATCHET
  const report = custom
    ? ((await strykerConfig(process.cwd(), config)).jsonReporter?.fileName ?? DEFAULT_REPORT)
    : DEFAULT_REPORT
  return {
    config,
    flags: custom ? ` --config ${config} --ratchet ${ratchet}` : '',
    report,
    stryker:
      config === DEFAULT_CONFIG ? 'pnpm exec stryker run' : `pnpm exec stryker run ${config}`,
  }
}

const DETECTED = new Set(['Killed', 'Timeout'])
const UNDETECTED = new Set(['Survived', 'NoCoverage'])

const cents = (score: number): number => Math.round(score * 100)

function percent(detected: number, valid: number): number {
  return Math.round((detected * 10000) / valid) / 100
}

function tally(mutants: Array<{ status?: string }>): {
  detected: number
  valid: number
  killed: number
} {
  let detected = 0
  let valid = 0
  let killed = 0
  for (const { status = '' } of mutants) {
    if (DETECTED.has(status)) detected += 1
    if (status === 'Killed') killed += 1
    if (DETECTED.has(status) || UNDETECTED.has(status)) valid += 1
  }
  return { detected, valid, killed }
}

/** Detected mutants that all timed out, none killed: no test is shown to have seen the file. */
const unmeasured = (t: { detected: number; killed: number }): boolean =>
  t.detected > 0 && t.killed === 0

/** Each file's score; a file with no valid mutant has none and is absent; an unmeasured file scores 0. */
export function scoreByFile(report: unknown): Scores {
  const scores: Scores = {}
  for (const [path, file] of Object.entries((report as StrykerReport).files ?? {})) {
    const t = tally(file.mutants ?? [])
    if (t.valid > 0) scores[path] = unmeasured(t) ? 0 : percent(t.detected, t.valid)
  }
  return scores
}

/** The files whose detected mutants all timed out, none killed. */
export function unmeasuredFiles(report: unknown): string[] {
  return Object.entries((report as StrykerReport).files ?? {})
    .filter(([, file]) => unmeasured(tally(file.mutants ?? [])))
    .map(([path]) => path)
    .sort()
}

const UNMEASURED_WHY = 'every detected mutant timed out, none killed'

/** The whole report's score, every file's mutants weighed together. */
export function totalScore(report: unknown): number {
  const all = Object.values((report as StrykerReport).files ?? {}).flatMap((f) => f.mutants ?? [])
  const { detected, valid } = tally(all)
  return valid === 0 ? 0 : percent(detected, valid)
}

export type Change = { file: string; ratchet: number; score: number; by: number }

/** Files in both whose score fell below the ratchet, and files whose score rose above it. */
export function compare(ratchet: Scores, scores: Scores): { lower: Change[]; rose: Change[] } {
  const lower: Change[] = []
  const rose: Change[] = []
  for (const [file, score] of Object.entries(scores).sort(([a], [b]) => a.localeCompare(b))) {
    const held = ratchet[file]
    if (held === undefined) continue
    const by = Math.abs(cents(held) - cents(score)) / 100
    if (cents(score) < cents(held)) lower.push({ file, ratchet: held, score, by })
    else if (cents(score) > cents(held)) rose.push({ file, ratchet: held, score, by })
  }
  return { lower, rose }
}

/** The ratchet with each file raised to its score where that is higher, and new files added; nothing is lowered. */
export function raise(ratchet: Scores, scores: Scores): Scores {
  const raised: Scores = { ...ratchet }
  for (const [file, score] of Object.entries(scores)) {
    const held = raised[file]
    raised[file] = held === undefined ? score : Math.max(held, score)
  }
  return Object.fromEntries(Object.entries(raised).sort(([a], [b]) => a.localeCompare(b)))
}

/**
 * `raise`, confined to `changed` and to files with no entry yet: an incremental run measures the files a change
 * touched, and the rest of its scores carry one-mutant noise from a cache (raising 16 entries to one run's exact
 * scores made the next run red in five untouched files on 2026-10-22). Those files keep their entries.
 */
export function raiseWithin(ratchet: Scores, scores: Scores, changed: Iterable<string>): Scores {
  const within = new Set(changed)
  const eligible = Object.fromEntries(
    Object.entries(scores).filter(([file]) => within.has(file) || ratchet[file] === undefined),
  )
  return raise(ratchet, eligible)
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/** The merge base of HEAD and `ref`, or undefined when `ref` does not resolve. */
function mergeBase(root: string, ref: string): string | undefined {
  const r = spawnSync('git', ['merge-base', 'HEAD', ref], { cwd: root, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : undefined
}

/**
 * The files `update` may raise: `--files` when given, else the work tree's changes against the merge base with
 * `--base` (GATE_BASE in CI, origin/dev by default, origin/main before dev exists).
 */
function raisable(root: string, files: string | undefined, base: string | undefined): string[] {
  if (files !== undefined)
    return files
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean)
  const refs = base === undefined ? ['origin/dev', 'origin/main'] : [base]
  const at = refs.map((ref) => mergeBase(root, ref)).find((sha) => sha !== undefined)
  if (at === undefined) {
    throw new Error(
      `update raises the files changed since ${refs.join(' or ')}, which does not resolve: pass --base <ref> or --files <a,b>`,
    )
  }
  return execFileSync('git', ['diff', '--name-only', at], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
}

/** The tracked files in a Stryker config's mutate set, or undefined outside a git work tree, where nothing is tracked. */
async function trackedMutateSet(root: string, config: string): Promise<string[] | undefined> {
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: root,
    encoding: 'utf8',
  })
  if (inside.status !== 0) return undefined
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n')
  return (await mutateSet(root, tracked.filter(Boolean), config)).sort()
}

/** A mutate-set file's unit test file: the `.test.ts` beside it. */
const unitTestOf = (path: string): string => path.replace(/\.ts$/, '.test.ts')

/**
 * The paths that differ between `base` and the work tree, committed or not, untracked files included: the files a
 * change touched, and the test files it added or changed beside them.
 */
function changedSince(root: string, base: string): string[] {
  const at =
    mergeBase(root, base) ??
    (spawnSync('git', ['rev-parse', '--verify', '--quiet', `${base}^{tree}`], { cwd: root })
      .status === 0
      ? base
      : undefined)
  if (at === undefined) throw new Error(`--base ${base} does not resolve here: pass a ref or sha`)
  const list = (args: string[]): string[] =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
  return [
    ...new Set([
      ...list(['diff', '--name-only', at]),
      ...list(['ls-files', '--others', '--exclude-standard']),
    ]),
  ]
}

async function check(report: unknown, ratchetPath: string, to: Target): Promise<number> {
  const ratchet = readJson<Ratchet>(ratchetPath)
  const { lower, rose } = compare(ratchet.files, scoreByFile(report))
  // A file with no entry cannot fall, so it does not fail the check; the hint keeps the ratchet following the set.
  const unheld = ((await trackedMutateSet(process.cwd(), to.config)) ?? []).filter(
    (path) => ratchet.files[path] === undefined,
  )
  for (const path of unheld) {
    process.stdout.write(`no ratchet entry: ${path}\n`)
  }
  for (const path of unmeasuredFiles(report)) {
    process.stdout.write(`unmeasured (${UNMEASURED_WHY}): ${path}: scores 0\n`)
  }
  for (const c of lower) {
    process.stdout.write(
      `below the ratchet: ${c.file} ${c.score.toFixed(2)} < ${c.ratchet.toFixed(2)} (down ${c.by.toFixed(2)})\n`,
    )
  }
  for (const c of rose) {
    process.stdout.write(
      `above the ratchet: ${c.file} ${c.score.toFixed(2)} > ${c.ratchet.toFixed(2)} (up ${c.by.toFixed(2)})\n`,
    )
  }
  if (rose.length > 0 || unheld.length > 0) {
    process.stdout.write(
      `bring the ratchet up to date with: pnpm mutation:ratchet update${to.flags} --report ${to.flags === '' ? '<mutation.json>' : to.report}\n`,
    )
  }
  if (lower.length > 0) {
    process.stdout.write(`mutation ratchet: ${lower.length} file(s) below their entry\n`)
    return 1
  }
  process.stdout.write('mutation ratchet: no file below its entry\n')
  return 0
}

/**
 * The ratchet against the mutate set, with no report: every tracked file in the set has an entry and every entry
 * names a file in it. Cheap enough for the plain gate, where a miss costs seconds instead of a gate:full's stryker
 * step finding it after everything else ran. The files with no unit test file beside them are named, so the gap
 * stays visible. With a base, a measured file (a non-zero entry) changed since it with its unit test file unchanged
 * gets a warning: that code may have no unit test, and the incremental Stryker run in CI says so after the merge.
 */
async function staticCheck(
  ratchetPath: string,
  base: string | undefined,
  to: Target,
): Promise<number> {
  const root = process.cwd()
  const ratchet = readJson<Ratchet>(ratchetPath)
  const set = await trackedMutateSet(root, to.config)
  if (set === undefined) {
    throw new Error(
      `check --static reads Stryker's mutate set from git: run it inside the repository`,
    )
  }
  const inSet = new Set(set)
  const unheld = set.filter((path) => ratchet.files[path] === undefined)
  const gone = Object.keys(ratchet.files).filter((path) => !inSet.has(path))
  for (const path of unheld) process.stdout.write(`no ratchet entry: ${path}\n`)
  for (const path of gone) process.stdout.write(`entry names no file in the mutate set: ${path}\n`)
  if (unheld.length > 0) {
    process.stdout.write(
      `a new file needs its measured score: ${to.stryker} --mutate <file> && pnpm mutation:ratchet update${to.flags} --report ${to.report} --files <file>\n`,
    )
  }
  if (gone.length > 0) {
    process.stdout.write(
      `a stale entry is dropped by: pnpm mutation:ratchet update${to.flags} --report ${to.report}\n`,
    )
  }
  const hasUnitTest = (path: string): boolean => existsSync(resolve(root, unitTestOf(path)))
  // Every file of another config's set is measured by integration tests by design.
  const noUnitTest = to.config === DEFAULT_CONFIG ? set.filter((path) => !hasUnitTest(path)) : []
  if (noUnitTest.length > 0) {
    process.stdout.write(
      `no unit test file (${noUnitTest.length}, measured by integration tests alone): ${noUnitTest.join(', ')}\n`,
    )
  }
  // A warning, never a failure: replayed over fifteen dev commits a refusal would have hit four of the five that
  // changed a measured file (one of them comment-only) for one real drop. The gate shows the line; the review reads it.
  if (base !== undefined) {
    const changed = new Set(changedSince(root, base))
    const untested = set.filter(
      (path) =>
        changed.has(path) &&
        (ratchet.files[path] ?? 0) > 0 &&
        hasUnitTest(path) &&
        !changed.has(unitTestOf(path)),
    )
    for (const path of untested) {
      process.stdout.write(
        `warning: ${path} changed with its unit test unchanged (entry ${(ratchet.files[path] ?? 0).toFixed(2)}; ${unitTestOf(path)} did not change since ${base}): new behaviour there wants a unit test, or the mutation run in CI finds the gap after the merge\n`,
      )
    }
  }
  if (unheld.length > 0 || gone.length > 0) {
    process.stdout.write(
      `mutation ratchet: ${unheld.length + gone.length} entry(ies) out of step with the mutate set\n`,
    )
    return 1
  }
  process.stdout.write(`mutation ratchet: ${set.length} entries, one per file in the mutate set\n`)
  return 0
}

async function update(
  report: unknown,
  ratchetPath: string,
  total: boolean,
  command: string,
  changed: () => string[],
  config: string,
): Promise<number> {
  const before: Ratchet | undefined = existsSync(ratchetPath)
    ? readJson<Ratchet>(ratchetPath)
    : undefined
  if (before === undefined && !total) {
    throw new Error(`${ratchetPath} does not exist: seed it with update --total from a full run`)
  }
  const set = await trackedMutateSet(process.cwd(), config)
  if (set === undefined) {
    throw new Error(`update reads Stryker's mutate set from git: run it inside the repository`)
  }
  // Entries follow the mutate set: a file renamed, deleted or no longer mutated loses its entry.
  const inSet = new Set(set)
  const follow = (scores: Scores): Scores =>
    Object.fromEntries(Object.entries(scores).filter(([path]) => inSet.has(path)))
  const dropped = Object.keys(before?.files ?? {}).filter((path) => !inSet.has(path))
  const held = follow(before?.files ?? {})
  const scores = follow(scoreByFile(report))
  // A full run's scores are all measured afresh; an incremental run's are trusted only where the change reached.
  const within = new Set(total ? Object.keys(scores) : changed())
  const files = total ? raise(held, scores) : raiseWithin(held, scores, within)
  // An unmeasured file's entry was never a measurement: it records 0, lowered if need be, where the run reached.
  const unmeasuredHere = unmeasuredFiles(report).filter(
    (path) => inSet.has(path) && (within.has(path) || held[path] === undefined),
  )
  for (const path of unmeasuredHere) files[path] = 0
  const kept = Object.keys(scores).filter((path) => {
    const was = held[path]
    return was !== undefined && files[path] === was && (scores[path] ?? 0) > was
  })
  let next: Ratchet
  if (total) {
    // The total stands for the whole mutate set, so a report from a run over part of it cannot set it.
    const reported = new Set(Object.keys((report as StrykerReport).files ?? {}))
    const missing = set.filter((path) => !reported.has(path))
    if (missing.length > 0) {
      process.stderr.write(
        `update --total needs a report covering the whole mutate set; missing:\n${missing.map((p) => `  ${p}\n`).join('')}`,
      )
      return 1
    }
    next = {
      measuredAt: new Date().toISOString(),
      command,
      total: totalScore(report),
      files,
    }
  } else {
    next = { ...(before as Ratchet), files }
  }
  writeFileSync(ratchetPath, `${JSON.stringify(next, null, 2)}\n`)
  for (const path of dropped) {
    process.stdout.write(`dropped (not in the mutate set): ${path}\n`)
  }
  for (const path of unmeasuredHere) {
    process.stdout.write(`unmeasured (${UNMEASURED_WHY}): ${path}: recorded 0\n`)
  }
  for (const path of kept) {
    process.stdout.write(`kept (not changed in the range; --files to raise it): ${path}\n`)
  }
  process.stdout.write(
    `wrote ${ratchetPath}: ${Object.keys(next.files).length} file(s), total ${next.total.toFixed(2)}\n`,
  )
  return 0
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      report: { type: 'string' },
      ratchet: { type: 'string' },
      config: { type: 'string', default: DEFAULT_CONFIG },
      total: { type: 'boolean', default: false },
      command: { type: 'string', default: DEFAULT_COMMAND },
      static: { type: 'boolean', default: false },
      files: { type: 'string' },
      base: { type: 'string', default: process.env['GATE_BASE'] },
    },
  })
  const [subcommand] = positionals
  if (values.ratchet === undefined && values.config !== DEFAULT_CONFIG) {
    // Defaulting here would write another config's scores into the unit ratchet.
    const paired = basename(values.config).replace(
      /^stryker\.(.+)\.config\.mjs$/,
      'mutation-ratchet.$1.json',
    )
    throw new Error(
      `--config ${values.config} needs --ratchet <file>${paired === basename(values.config) ? '' : ` (${paired})`}: only ${DEFAULT_CONFIG} pairs with ${DEFAULT_RATCHET}`,
    )
  }
  const ratchet = values.ratchet ?? DEFAULT_RATCHET
  const ratchetPath = resolve(ratchet)
  const base = values.base === undefined || values.base === '' ? undefined : values.base
  const to = await target(values.config, ratchet)
  if (subcommand === 'check' && values.static) return staticCheck(ratchetPath, base, to)
  if (values.report === undefined || (subcommand !== 'check' && subcommand !== 'update')) {
    throw new Error(
      'usage: mutation-ratchet.ts check --static [--base <ref>] [--config <stryker config>] [--ratchet <file>] | check --report <mutation.json> [--config <stryker config>] [--ratchet <file>] | update --report <mutation.json> [--config <stryker config>] [--ratchet <file>] [--total] [--command <text>] [--files <a,b> | --base <ref>]',
    )
  }
  const report = readJson<unknown>(resolve(values.report))
  return subcommand === 'check'
    ? check(report, ratchetPath, to)
    : update(
        report,
        ratchetPath,
        values.total,
        values.command,
        () => raisable(process.cwd(), values.files, base),
        values.config,
      )
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 2
    },
  )
}
