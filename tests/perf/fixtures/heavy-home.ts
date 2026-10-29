import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

// The fixtures: copies of the Astro template whose home page loads one more script. AC-2's is 300 KB of pseudo-random
// base64, so gzip leaves most of it (about 230 KB): a byte budget measured on gzip still sees it. AC-6's is sized to a
// gzip size between the page's reference and its budget. Each copy shares the template's node_modules (a symlink), so
// it builds as the template does, and the template itself is never touched.

export const FIXTURE_SCRIPT = 'perf-fixture-heavy.js'
const SIZE = 300 * 1024

/** Deterministic pseudo-random base64 (xorshift32): gzip leaves most of it, so its gzip size tracks its length. */
function noise(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let state = 0x2f6b_1d3a
  let body = ''
  while (body.length < length) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    body += alphabet[(state >>> 0) % 64]
  }
  return body
}

const PREFIX = 'window.__nymbalPerfFixture="'
const SUFFIX = '";\n'

/** The fixture script: deterministic, so its gzip size is the same on every run. */
export function heavyScript(): string {
  return PREFIX + noise(SIZE - PREFIX.length - SUFFIX.length) + SUFFIX
}

/** The gzip size of the fixture script, which the run's `scriptBytes` for the home page should grow by. */
export function heavyScriptGzipBytes(): number {
  return gzipSync(heavyScript()).length
}

/**
 * The longest fixture script whose gzip size is at most `target` bytes, with that size: AC-6's script, sized to lift
 * a page above its reference and keep it under its budget. Throws when no script is that small.
 */
export function scriptOfGzipSize(target: number): { script: string; gzipBytes: number } {
  const of = (n: number): string => `${PREFIX}${noise(n)}${SUFFIX}`
  const size = (n: number): number => gzipSync(of(n)).length
  if (size(0) > target) throw new Error(`no fixture script gzips to ${target} bytes or fewer`)
  let lo = 0
  let hi = target * 2
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (size(mid) <= target) lo = mid
    else hi = mid - 1
  }
  return { script: of(lo), gzipBytes: size(lo) }
}

/**
 * Copies `templates/astro` (without node_modules, dist and .astro) to a new directory, links its node_modules, and
 * adds `script` to the home page as `/<name>`. Returns the copy's path.
 */
export function astroWithHomeScript(repo: string, name: string, script: string): string {
  const source = join(repo, 'templates/astro')
  const copy = mkdtempSync(join(tmpdir(), 'nymbal-perf-home-script-'))
  cpSync(source, copy, {
    recursive: true,
    filter: (path) => !/[/\\](node_modules|dist|\.astro)([/\\]|$)/.test(path.slice(source.length)),
  })
  symlinkSync(join(source, 'node_modules'), join(copy, 'node_modules'), 'dir')

  mkdirSync(join(copy, 'public'), { recursive: true })
  writeFileSync(join(copy, 'public', name), script)

  const indexPage = join(copy, 'src/pages/index.astro')
  const page = readFileSync(indexPage, 'utf8')
  const close = page.lastIndexOf('</BaseLayout>')
  if (close < 0)
    throw new Error(`${indexPage} has no </BaseLayout>; the fixture cannot add its script`)
  writeFileSync(
    indexPage,
    `${page.slice(0, close)}  <script is:inline async src="/${name}"></script>\n${page.slice(close)}`,
  )
  return copy
}

/** The Astro template with the 300 KB fixture script on its home page. */
export function astroWithHeavyHome(repo: string): string {
  return astroWithHomeScript(repo, FIXTURE_SCRIPT, heavyScript())
}
