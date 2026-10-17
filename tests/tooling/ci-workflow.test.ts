import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type PlanInput, plan } from '../../scripts/gate'

// Acceptance tests for P0-03 part 2, AC-4: every pull-request job except `build` downloads the one artefact `build`
// uploads, and none of them runs `pnpm build` (directly, or through a gate.ts plan that would).
// No YAML library is a dependency of the repo, so the workflow is read by the small block-YAML reader below. It
// throws on anything outside the subset GitHub workflows here use, and the job list it returns is checked against
// the job keys found textually, so a misread fails loudly instead of passing quietly.

const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url))

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

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, string> }
type Job = { needs?: string | string[]; steps?: Step[] }

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

function loadJobs(): Record<string, Job> {
  const source = readFileSync(WORKFLOW, 'utf8')
  const doc = parseYaml(source) as { jobs?: Record<string, Job> }
  const jobs = doc.jobs ?? {}
  const parsed = Object.keys(jobs)
  const textual = textualJobIds(source)
  if (parsed.join(',') !== textual.join(',')) {
    throw new Error(`ci.yml misread: parsed jobs [${parsed}] but the text has [${textual}]`)
  }
  return jobs
}

const runs = (job: Job): string[] =>
  (job.steps ?? []).flatMap((s) => (typeof s.run === 'string' ? [s.run.replace(/\\\n/g, ' ')] : []))
const needsOf = (job: Job): string[] =>
  job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs]

/** `pnpm build`, `pnpm build:templates`, `pnpm --filter X build`, `pnpm run build`, or a framework build. */
const BUILD =
  /\bpnpm\s+(?:(?:-r|--recursive|(?:--filter|-F)(?:=|\s+)\S+)\s+)*(?:run\s+)?build(?::templates)?\b|\b(?:vite|astro|next|tsup)\s+build\b/

const RUNS_TESTS =
  /scripts\/gate\.ts|\bgate:full\b|\bvitest\b|\bplaywright\s+test\b|\bstryker\b|\bpnpm\s+(?:run\s+)?(?:test|mutation|sentinels)\b|create-nymbal-app/

/** The pull-request jobs the spec names (besides build and the P0-04 changeset job). */
const SPEC_JOBS = [
  'gate',
  'integration',
  'mutation',
  'sentinels',
  'e2e-astro',
  'e2e-nextjs',
  'e2e-admin',
  'scaffold-smoke',
]

function uploadsOf(job: Job): Step[] {
  return (job.steps ?? []).filter((s) => s.uses?.startsWith('actions/upload-artifact@'))
}

function artefactName(step: Step): string {
  return step.with?.name ?? 'artifact'
}

/** Shell words, honouring single and double quotes (step names such as 'census trend' hold spaces). */
function words(text: string): string[] {
  const out: string[] = []
  const re = /'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g
  let current = ''
  let last = -1
  for (const m of text.matchAll(re)) {
    const piece = m[1] ?? m[2] ?? m[3] ?? ''
    if (last === m.index) current += piece
    else {
      if (last !== -1) out.push(current)
      current = piece
    }
    last = m.index + m[0].length
  }
  if (last !== -1) out.push(current)
  return out
}

/** Each gate.ts (or gate:full) invocation in a run script: the words after it, up to the end of that command. */
function gateInvocations(script: string): string[][] {
  const found: string[][] = []
  for (const m of script.matchAll(
    /(?:scripts\/gate\.ts|\bpnpm\s+(?:run\s+)?gate:full)([^\n;&|]*)/g,
  )) {
    found.push(words(m[1] ?? ''))
  }
  return found
}

function flag(args: string[], name: string): string | undefined {
  const at = args.findIndex((a) => a === name || a.startsWith(`${name}=`))
  if (at === -1) return undefined
  const arg = args[at]!
  return arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[at + 1]
}

describe('AC-4: one artefact, built once, downloaded by every other job', () => {
  it('AC-4: the build job runs the builds and uploads one artefact holding packages, templates and admin', () => {
    const build = loadJobs().build
    expect(build, 'ci.yml has a build job').toBeDefined()
    const uploads = uploadsOf(build!)
    expect(uploads).toHaveLength(1)
    const path = uploads[0]!.with?.path ?? ''
    const missing = ['packages/', 'templates/', 'apps/admin'].filter((p) => !path.includes(p))
    expect(missing, `upload path:\n${path}`).toEqual([])
    const scripts = runs(build!).join('\n')
    expect(scripts).toMatch(/\bpnpm\s+build(?!:)\b/)
    expect(scripts).toMatch(/\bpnpm\s+build:templates\b/)
  })

  it('AC-4: no job but build runs pnpm build or pnpm build:templates', () => {
    const jobs = loadJobs()
    const offenders = Object.entries(jobs)
      .filter(([id]) => id !== 'build')
      .flatMap(([id, job]) =>
        runs(job)
          .filter((script) => BUILD.test(script))
          .map((script) => `${id}: ${script.trim().split('\n')[0]}`),
      )
    expect(offenders).toEqual([])
  })

  it('AC-4: every job that runs tests needs build and downloads, before its first test, the artefact build uploads', () => {
    const jobs = loadJobs()
    const testJobs = Object.keys(jobs).filter(
      (id) => id !== 'build' && runs(jobs[id]!).some((script) => RUNS_TESTS.test(script)),
    )
    expect(
      SPEC_JOBS.filter((id) => !testJobs.includes(id)),
      `test jobs: ${testJobs}`,
    ).toEqual([])

    const upload = uploadsOf(jobs.build ?? {})[0]
    expect(upload, 'build uploads an artefact').toBeDefined()
    const failures: string[] = []
    for (const id of testJobs) {
      const job = jobs[id]!
      if (!needsOf(job).includes('build')) failures.push(`${id}: does not need build`)
      const steps = job.steps ?? []
      const download = steps.findIndex(
        (s) =>
          s.uses?.startsWith('actions/download-artifact@') &&
          (s.with?.name === undefined || s.with.name === artefactName(upload!)),
      )
      const firstTest = steps.findIndex((s) => typeof s.run === 'string' && RUNS_TESTS.test(s.run))
      if (download === -1) failures.push(`${id}: does not download "${artefactName(upload!)}"`)
      else if (download > firstTest)
        failures.push(`${id}: downloads the artefact after its tests start`)
    }
    expect(failures).toEqual([])
  })

  it('AC-4: every gate.ts invocation outside build names --only steps whose plan runs no build', () => {
    const jobs = loadJobs()
    const failures: string[] = []
    let invocations = 0
    for (const [id, job] of Object.entries(jobs)) {
      if (id === 'build') continue
      for (const script of runs(job)) {
        for (const args of gateInvocations(script)) {
          invocations += 1
          const only = flag(args, '--only')
          if (only === undefined) {
            failures.push(`${id}: gate.ts without --only runs the whole gate, build included`)
            continue
          }
          const external = flag(args, '--services') === 'external'
          const input: PlanInput = {
            full: true,
            base: 'HEAD',
            changed: [],
            mutated: ['packages/sdk/src/client.ts'],
            only: only.split(',').map((n) => n.trim()),
            services: external ? 'external' : 'compose',
            postgresUrl: external ? 'postgres://ci:ci@127.0.0.1:5432/ci' : undefined,
            noBuild: args.includes('--no-build'),
            artefactPresent: true,
          }
          try {
            for (const step of plan(input).steps) {
              if (step.skip === undefined && BUILD.test(step.command)) {
                failures.push(`${id}: --only ${only} runs "${step.name}": ${step.command}`)
              }
            }
          } catch (error) {
            failures.push(
              `${id}: --only ${only}: ${error instanceof Error ? error.message : error}`,
            )
          }
        }
      }
    }
    expect(invocations).toBeGreaterThan(0)
    expect(failures).toEqual([])
  })
})
