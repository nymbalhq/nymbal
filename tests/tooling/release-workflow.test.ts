import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// AC-12 (release.yml) and the workflow half of AC-11 (canary.yml).
// AC-12: version and the release commit run only when changesets exist; the build runs before the commit and its
// outputs are committed; publish, tags and GitHub releases run whenever the tokens exist (they are idempotent), so a
// re-run after a failed publish completes the release.
// AC-11: canary.yml runs scripts/canary-ready.ts before publishing and gates the publish on its `ready` output.
// No YAML library is a dependency of the repo, so the workflows are read by the small block-YAML reader below (the
// one ci-workflow.test.ts uses). It throws on anything outside the subset the workflows use, and the job list it
// returns is checked against the job keys found textually, so a misread fails loudly instead of passing quietly.

const RELEASE = fileURLToPath(new URL('../../.github/workflows/release.yml', import.meta.url))
const CANARY = fileURLToPath(new URL('../../.github/workflows/canary.yml', import.meta.url))

type Yaml = string | null | Yaml[] | { [key: string]: Yaml }

function parseYaml(source: string): Yaml {
  const raw = source.split('\n').map((line) => line.replace(/\r$/, ''))
  let i = 0

  const blank = (line: string): boolean => /^\s*(?:#.*)?$/.test(line)
  const indentOf = (line: string): number => {
    const lead = /^[ \t]*/.exec(line)![0]
    if (lead.includes('\t')) throw new Error(`line ${i + 1}: tab in indentation`)
    return lead.length
  }
  const isSeqItem = (text: string): boolean => /^-(?: |$)/.test(text)
  const MAP_ENTRY = /^("[^"]*"|'[^']*'|[^\s"'#\-[{][^:]*?):(?: +(.*))?$/

  function skipBlank(): void {
    while (i < raw.length && blank(raw[i]!)) i += 1
  }

  function stripComment(value: string): string {
    const v = value.trim()
    if (v.startsWith('"') || v.startsWith("'")) {
      const quote = v[0]!
      let j = 1
      while (j < v.length) {
        if (v[j] === quote) {
          if (quote === "'" && v[j + 1] === "'") {
            j += 2
            continue
          }
          break
        }
        if (quote === '"' && v[j] === '\\') j += 1
        j += 1
      }
      return v.slice(0, j + 1)
    }
    const hash = v.search(/\s#/)
    return (hash === -1 ? v : v.slice(0, hash)).trim()
  }

  function scalar(value: string): Yaml {
    const v = stripComment(value)
    if (/^[&*!%{@`]/.test(v) || /^[|>]/.test(v)) {
      throw new Error(`line ${i}: unsupported YAML construct: ${v}`)
    }
    if (v.startsWith("'")) return v.slice(1, -1).replaceAll("''", "'")
    if (v.startsWith('"')) {
      return v.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c))
    }
    if (v.startsWith('[')) {
      if (!v.endsWith(']')) throw new Error(`line ${i}: multi-line flow sequence: ${v}`)
      const inner = v.slice(1, -1).trim()
      return inner === '' ? [] : inner.split(',').map((part) => scalar(part))
    }
    return v === '' || v === '~' || v === 'null' ? null : v
  }

  function blockScalar(parentIndent: number, indicator: string): string {
    const body: string[] = []
    let contentIndent: number | undefined
    while (i < raw.length) {
      const line = raw[i]!
      if (line.trim() === '') {
        body.push('')
        i += 1
        continue
      }
      const ind = indentOf(line)
      if (ind <= parentIndent) break
      contentIndent ??= ind
      body.push(line.slice(contentIndent))
      i += 1
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop()
    const text = indicator.startsWith('>') ? body.join(' ') : body.join('\n')
    return indicator.endsWith('-') ? text : `${text}\n`
  }

  function node(minIndent: number): Yaml {
    skipBlank()
    if (i >= raw.length) return null
    const ind = indentOf(raw[i]!)
    if (ind < minIndent) return null
    return isSeqItem(raw[i]!.trimStart()) ? sequence(ind) : mapping(ind)
  }

  function sequence(ind: number): Yaml[] {
    const out: Yaml[] = []
    for (;;) {
      skipBlank()
      if (i >= raw.length) break
      const line = raw[i]!
      const text = line.trimStart()
      if (indentOf(line) !== ind || !isSeqItem(text)) break
      const rest = text.slice(1)
      const content = rest.trimStart()
      if (content === '') {
        i += 1
        out.push(node(ind + 1))
      } else if (MAP_ENTRY.test(content)) {
        const col = ind + 1 + (rest.length - content.length)
        raw[i] = ' '.repeat(col) + content
        out.push(mapping(col))
      } else {
        i += 1
        out.push(scalar(content))
      }
    }
    return out
  }

  function mapping(ind: number): { [key: string]: Yaml } {
    const out: { [key: string]: Yaml } = {}
    for (;;) {
      skipBlank()
      if (i >= raw.length) break
      const line = raw[i]!
      const lineIndent = indentOf(line)
      if (lineIndent < ind) break
      if (lineIndent > ind) throw new Error(`line ${i + 1}: unexpected indentation: ${line}`)
      const text = line.trimStart()
      if (isSeqItem(text)) break
      const m = MAP_ENTRY.exec(text)
      if (m === null) throw new Error(`line ${i + 1}: not a mapping entry: ${text}`)
      const key = m[1]!.replace(/^(["'])(.*)\1$/, '$2')
      if (key in out) throw new Error(`line ${i + 1}: duplicate key ${key}`)
      const value = stripComment(m[2] ?? '')
      i += 1
      if (value === '') {
        skipBlank()
        const next = raw[i]
        if (next !== undefined && indentOf(next) === ind && isSeqItem(next.trimStart())) {
          out[key] = sequence(ind)
        } else {
          out[key] = node(ind + 1)
        }
      } else if (/^[|>][-+]?$/.test(value)) {
        out[key] = blockScalar(ind, value)
      } else {
        out[key] = scalar(value)
      }
    }
    return out
  }

  const doc = node(0)
  skipBlank()
  if (i < raw.length) throw new Error(`line ${i + 1}: unparsed content: ${raw[i]}`)
  return doc
}

type Step = {
  id?: string
  name?: string
  uses?: string
  run?: string
  if?: string
  with?: Record<string, string>
}
type Job = { needs?: string | string[]; if?: string; steps?: Step[] }

/** The job keys as they appear in the text: two-space keys under the top-level `jobs:`. */
function textualJobIds(source: string): string[] {
  const ids: string[] = []
  let inJobs = false
  for (const line of source.split('\n')) {
    if (/^\S/.test(line) && !line.startsWith('#')) inJobs = /^jobs:\s*(?:#.*)?$/.test(line)
    const m = inJobs ? /^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(line) : null
    if (m !== null) ids.push(m[1]!)
  }
  return ids
}

function loadJobs(path: string): Record<string, Job> {
  const source = readFileSync(path, 'utf8')
  const doc = parseYaml(source) as { jobs?: Record<string, Job> }
  const jobs = doc.jobs ?? {}
  const parsed = Object.keys(jobs)
  const textual = textualJobIds(source)
  if (parsed.join(',') !== textual.join(',')) {
    throw new Error(`${path} misread: parsed jobs [${parsed}] but the text has [${textual}]`)
  }
  return jobs
}

type Located = { job: string; index: number; step: Step; run: string; condition: string }

/** Every step with its job, its position in the job and its effective `if:` (the job's and the step's). */
function stepsOf(jobs: Record<string, Job>): Located[] {
  return Object.entries(jobs).flatMap(([job, j]) =>
    (j.steps ?? []).map((step, index) => ({
      job,
      index,
      step,
      run: typeof step.run === 'string' ? step.run.replace(/\\\n/g, ' ') : '',
      condition: [j.if, step.if].filter((c): c is string => typeof c === 'string').join(' && '),
    })),
  )
}

/** The one step whose `run:` matches; the count is asserted so a missing or doubled step reads as such. */
function only(steps: Located[], what: string, pattern: RegExp): Located {
  const found = steps.filter((s) => pattern.test(s.run))
  expect(
    found.map((s) => `${s.job}[${s.index}]`),
    `exactly one step should ${what}`,
  ).toHaveLength(1)
  return found[0]!
}

const needsOf = (job: Job): string[] =>
  job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs]

/** Every job `id` depends on, directly or through other jobs. */
function ancestors(jobs: Record<string, Job>, id: string): string[] {
  const seen = new Set<string>()
  const visit = (j: string): void => {
    for (const n of needsOf(jobs[j] ?? {})) {
      if (!seen.has(n)) {
        seen.add(n)
        visit(n)
      }
    }
  }
  visit(id)
  return [...seen]
}

const MENTIONS_CHANGESETS = /changeset/i
const MENTIONS_TOKEN = /token/i
/** A job only runs after a skipped dependency when its `if:` uses one of these status functions. */
const SURVIVES_SKIPPED_NEEDS = /\balways\(\)|!\s*cancelled\(\)/

const VERSION = /\bchangeset\s+version\b(?![^\n]*--snapshot)/
const COMMIT = /\bgit\s+commit\b/
const PUBLISH = /\bchangeset\s+publish\b/
const PUSH_TAGS = /\bgit\s+push\b[^\n]*--(?:follow-)?tags\b/
const GH_RELEASE = /\bgh\s+release\s+create\b/
/** `pnpm build`, `pnpm -r build`, `pnpm --filter X build`, `pnpm run build`. */
const BUILD = /\bpnpm\s+(?:(?:-r|--recursive|(?:--filter|-F)(?:=|\s+)\S+)\s+)*(?:run\s+)?build\b/
/** Stages everything the build rewrote: `git add -A|--all|.`, `git commit -a…`, or the scaffold templates path. */
const STAGES_BUILD_OUTPUT =
  /\bgit\s+add\s+(?:[^\n]*\s)?(?:-A|--all|\.)(?:\s|$)|\bgit\s+commit\s+(?:[^\n]*\s)?-[a-zA-Z]*a[a-zA-Z]*\b|templates/

describe('AC-12: release.yml', () => {
  const jobs = loadJobs(RELEASE)
  const steps = stepsOf(jobs)

  it('AC-12: version and the release commit run only with changesets; publish, tags and releases run on the tokens alone, from the branch tip', () => {
    const version = only(steps, 'run `changeset version`', VERSION)
    const commit = only(steps, 'make the release commit', COMMIT)
    expect(version.condition, 'the version step is conditioned on changesets').toMatch(
      MENTIONS_CHANGESETS,
    )
    expect(commit.condition, 'the commit step is conditioned on changesets').toMatch(
      MENTIONS_CHANGESETS,
    )

    const publishing = [
      only(steps, 'run `changeset publish`', PUBLISH),
      only(steps, 'push the tags', PUSH_TAGS),
      only(steps, 'create the GitHub releases', GH_RELEASE),
    ]
    for (const s of publishing) {
      const where = `${s.job}[${s.index}] ${s.step.name ?? s.run.split('\n')[0]}`
      expect(s.condition, `${where} must not depend on changesets`).not.toMatch(MENTIONS_CHANGESETS)
      expect(s.condition, `${where} must be gated on the tokens`).toMatch(MENTIONS_TOKEN)
      // A job that needs a job skipped for want of changesets is itself skipped, unless it uses a status function.
      const skippable = ancestors(jobs, s.job).filter((a) =>
        MENTIONS_CHANGESETS.test(jobs[a]?.if ?? ''),
      )
      expect(
        skippable.length === 0 || SURVIVES_SKIPPED_NEEDS.test(jobs[s.job]!.if ?? ''),
        `${s.job} needs ${skippable} and must still run when they are skipped: if "${jobs[s.job]!.if ?? ''}"`,
      ).toBe(true)
      // A re-run replays the original push; only checking out the branch tip sees the release commit.
      for (const checkout of (jobs[s.job]!.steps ?? []).filter((x) =>
        x.uses?.startsWith('actions/checkout@'),
      )) {
        expect(
          checkout.with?.ref ?? '',
          `${s.job} checks out the branch tip, not the pushed sha`,
        ).toMatch(/github\.ref\b|\bmain\b/)
      }
    }
  })

  it('AC-12: the build runs after versioning and before the release commit, the commit stages its outputs, and a build not tied to changesets precedes publish', () => {
    const version = only(steps, 'run `changeset version`', VERSION)
    const commit = only(steps, 'make the release commit', COMMIT)
    const publish = only(steps, 'run `changeset publish`', PUBLISH)

    expect(commit.job, 'version and commit share a job').toBe(version.job)
    const builds = steps.filter((s) => BUILD.test(s.run))
    const buildBeforeCommit = builds.filter(
      (s) => s.job === commit.job && s.index > version.index && s.index < commit.index,
    )
    expect(
      buildBeforeCommit.map((s) => s.index),
      `a build step between version (${version.index}) and commit (${commit.index}) in ${commit.job}; builds at ${builds.map((s) => `${s.job}[${s.index}]`)}`,
    ).not.toHaveLength(0)
    expect(commit.run, 'the release commit stages what the build rewrote').toMatch(
      STAGES_BUILD_OUTPUT,
    )

    const buildBeforePublish = builds.filter(
      (s) =>
        s.job === publish.job && s.index < publish.index && !MENTIONS_CHANGESETS.test(s.condition),
    )
    expect(
      buildBeforePublish.map((s) => s.index),
      `a build not conditioned on changesets precedes publish (${publish.job}[${publish.index}])`,
    ).not.toHaveLength(0)
  })
})

describe('AC-11: canary.yml', () => {
  const jobs = loadJobs(CANARY)
  const steps = stepsOf(jobs)

  it('AC-11: canary.yml runs scripts/canary-ready.ts before publishing and gates publish on its ready output', () => {
    const ready = only(steps, 'run scripts/canary-ready.ts', /scripts\/canary-ready\.ts\b/)
    const publish = only(steps, 'run `changeset publish`', PUBLISH)

    expect(ready.step.id, 'the readiness step has an id to read its output by').toMatch(/^[\w-]+$/)
    const id = ready.step.id!.replace(/[-]/g, '\\-')
    const gate = new RegExp(`steps\\.${id}\\.outputs\\.ready\\s*==\\s*'true'`)
    for (const s of [publish]) {
      expect(s.job, `${s.step.name ?? s.run} runs in the readiness step's job`).toBe(ready.job)
      expect(s.index, `${s.step.name ?? s.run} runs after the readiness step`).toBeGreaterThan(
        ready.index,
      )
      expect(s.condition, `${s.step.name ?? s.run} is gated on the readiness output`).toMatch(gate)
    }
  })
})
