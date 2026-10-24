import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { mutateSet } from './gate'

// The mutation ratchet: mutation-ratchet.json records each mutated file's best Stryker score, and a run that scores a
// file below its entry fails. `check` runs in gate:full after Stryker and `check --static` (entries against the
// mutate set, no report) in the plain gate; `update` raises entries and never lowers one: with `--total` every
// file, otherwise only the files changed since the base (`--base`, GATE_BASE, origin/dev) or named by `--files`,
// and files with no entry yet.
// Scores are percent with two decimals: (killed + timeout) / (killed + timeout + survived + noCoverage) × 100.

export type Scores = Record<string, number>

export type Ratchet = { measuredAt: string; command: string; total: number; files: Scores }

type StrykerReport = { files?: Record<string, { mutants?: Array<{ status?: string }> }> }

export const DEFAULT_COMMAND = 'pnpm mutation --force'

const DETECTED = new Set(['Killed', 'Timeout'])
const UNDETECTED = new Set(['Survived', 'NoCoverage'])

const cents = (score: number): number => Math.round(score * 100)

function percent(detected: number, valid: number): number {
  return Math.round((detected * 10000) / valid) / 100
}

function tally(mutants: Array<{ status?: string }>): { detected: number; valid: number } {
  let detected = 0
  let valid = 0
  for (const { status = '' } of mutants) {
    if (DETECTED.has(status)) detected += 1
    if (DETECTED.has(status) || UNDETECTED.has(status)) valid += 1
  }
  return { detected, valid }
}

/** Each file's score; a file with no valid mutant has none and is absent. */
export function scoreByFile(report: unknown): Scores {
  const scores: Scores = {}
  for (const [path, file] of Object.entries((report as StrykerReport).files ?? {})) {
    const { detected, valid } = tally(file.mutants ?? [])
    if (valid > 0) scores[path] = percent(detected, valid)
  }
  return scores
}

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

/** The tracked files in Stryker's mutate set, or undefined outside a git work tree, where nothing is tracked. */
async function trackedMutateSet(root: string): Promise<string[] | undefined> {
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: root,
    encoding: 'utf8',
  })
  if (inside.status !== 0) return undefined
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n')
  return (await mutateSet(root, tracked.filter(Boolean))).sort()
}

async function check(report: unknown, ratchetPath: string): Promise<number> {
  const ratchet = readJson<Ratchet>(ratchetPath)
  const { lower, rose } = compare(ratchet.files, scoreByFile(report))
  // A file with no entry cannot fall, so it does not fail the check; the hint keeps the ratchet following the set.
  const unheld = ((await trackedMutateSet(process.cwd())) ?? []).filter(
    (path) => ratchet.files[path] === undefined,
  )
  for (const path of unheld) {
    process.stdout.write(`no ratchet entry: ${path}\n`)
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
      'bring the ratchet up to date with: pnpm mutation:ratchet update --report <mutation.json>\n',
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
 * step finding it after everything else ran.
 */
async function staticCheck(ratchetPath: string): Promise<number> {
  const ratchet = readJson<Ratchet>(ratchetPath)
  const set = await trackedMutateSet(process.cwd())
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
      'a new file needs its measured score: pnpm exec stryker run --mutate <file> && pnpm mutation:ratchet update --report reports/mutation/mutation.json --files <file>\n',
    )
  }
  if (gone.length > 0) {
    process.stdout.write(
      'a stale entry is dropped by: pnpm mutation:ratchet update --report reports/mutation/mutation.json\n',
    )
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
): Promise<number> {
  const before: Ratchet | undefined = existsSync(ratchetPath)
    ? readJson<Ratchet>(ratchetPath)
    : undefined
  if (before === undefined && !total) {
    throw new Error(`${ratchetPath} does not exist: seed it with update --total from a full run`)
  }
  const set = await trackedMutateSet(process.cwd())
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
  const files = total ? raise(held, scores) : raiseWithin(held, scores, changed())
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
      ratchet: { type: 'string', default: 'mutation-ratchet.json' },
      total: { type: 'boolean', default: false },
      command: { type: 'string', default: DEFAULT_COMMAND },
      static: { type: 'boolean', default: false },
      files: { type: 'string' },
      base: { type: 'string', default: process.env['GATE_BASE'] },
    },
  })
  const [subcommand] = positionals
  const ratchetPath = resolve(values.ratchet)
  if (subcommand === 'check' && values.static) return staticCheck(ratchetPath)
  if (values.report === undefined || (subcommand !== 'check' && subcommand !== 'update')) {
    throw new Error(
      'usage: mutation-ratchet.ts check --static [--ratchet <file>] | check --report <mutation.json> [--ratchet <file>] | update --report <mutation.json> [--ratchet <file>] [--total] [--command <text>] [--files <a,b> | --base <ref>]',
    )
  }
  const report = readJson<unknown>(resolve(values.report))
  const base = values.base === undefined || values.base === '' ? undefined : values.base
  return subcommand === 'check'
    ? check(report, ratchetPath)
    : update(report, ratchetPath, values.total, values.command, () =>
        raisable(process.cwd(), values.files, base),
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
