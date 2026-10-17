import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

// Decides whether a canary may publish. npm gives a package's first publish the `latest` tag whatever `--tag` says,
// so a canary must never be the first publish of anything:
//   - a public package the snapshot versions must already exist on npm at some version;
//   - a public package the snapshot leaves alone must exist at its current version, because `changeset publish`
//     publishes every public package whose current version is missing from the registry.
// Private packages are never published. A snapshot that versions no public package has nothing to publish.
//
//   pnpm -r list --json --depth -1 > before.json
//   pnpm changeset version --snapshot canary
//   pnpm -r list --json --depth -1 > after.json
//   pnpm exec tsx scripts/canary-ready.ts --before before.json --after after.json
//
// Prints `ready=true|false` (also appended to $GITHUB_OUTPUT when set) and exits 0 either way.

export type WorkspacePackage = { name: string; version: string; private: boolean }
export type Readiness = { ready: boolean; missing: string[] }

/** `registry(name)` asks whether any version exists; `registry(name@x.y.z)` whether that exact version does. */
export function canaryReady(
  packages: WorkspacePackage[],
  snapshotted: Set<string>,
  registry: (spec: string) => boolean,
): Readiness {
  const published = packages.filter((pkg) => !pkg.private)
  const missing = published
    .filter((pkg) => !registry(snapshotted.has(pkg.name) ? pkg.name : `${pkg.name}@${pkg.version}`))
    .map((pkg) => pkg.name)
  const publishesSomething = published.some((pkg) => snapshotted.has(pkg.name))
  return { ready: publishesSomething && missing.length === 0, missing }
}

type ListedPackage = { name?: string; version?: string; private?: boolean }

function readListing(path: string): WorkspacePackage[] {
  const listed = JSON.parse(readFileSync(path, 'utf8')) as ListedPackage[]
  if (!Array.isArray(listed))
    throw new Error(`${path}: expected the array \`pnpm -r list --json\` prints`)
  return listed
    .filter((pkg): pkg is ListedPackage & { name: string } => typeof pkg.name === 'string')
    .map((pkg) => ({ name: pkg.name, version: pkg.version ?? '', private: pkg.private === true }))
}

const out = (line: string): void => {
  process.stdout.write(`${line}\n`)
}

/** `npm view <spec> version`: E404 means absent; any other failure is reported and also counts as absent. */
function npmHas(spec: string): boolean {
  const result = spawnSync('npm', ['view', spec, 'version'], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status === 0) return result.stdout.trim() !== ''
  if (!/\bE404\b/.test(result.stderr)) {
    const reason =
      result.stderr.split('\n').find((line) => /error/i.test(line)) ?? `exit ${result.status}`
    out(`::warning::npm view ${spec} failed (${reason.trim()}); treating it as absent.`)
  }
  return false
}

function main(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: { before: { type: 'string' }, after: { type: 'string' } },
  })
  if (values.before === undefined || values.after === undefined) {
    throw new Error('usage: canary-ready.ts --before <pnpm-list.json> --after <pnpm-list.json>')
  }
  const before = readListing(values.before)
  const after = new Map(readListing(values.after).map((pkg) => [pkg.name, pkg.version]))
  const snapshotted = new Set(
    before
      .filter((pkg) => after.has(pkg.name) && after.get(pkg.name) !== pkg.version)
      .map((pkg) => pkg.name),
  )

  const { ready, missing } = canaryReady(before, snapshotted, npmHas)
  if (missing.length > 0) {
    out(`::notice::Skipping the canary until these exist on npm: ${missing.join(', ')}`)
  } else if (!ready) {
    out('::notice::The snapshot versions no public package, no canary to publish.')
  }
  out(`ready=${ready}`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `ready=${ready}\n`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2))
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
