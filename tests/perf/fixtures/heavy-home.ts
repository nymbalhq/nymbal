import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

// AC-2's fixture: a copy of the Astro template whose home page loads one more script of 300 KB. Its content is
// pseudo-random base64, so gzip leaves most of it (about 230 KB): a byte budget measured on gzip still sees it. The
// copy shares the template's node_modules (a symlink), so it builds as the template does, and the template itself is
// never touched.

export const FIXTURE_SCRIPT = 'perf-fixture-heavy.js'
const SIZE = 300 * 1024

/** The fixture script: deterministic, so its gzip size is the same on every run. */
export function heavyScript(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const prefix = 'window.__nymbalPerfFixture="'
  const suffix = '";\n'
  let state = 0x2f6b_1d3a
  let body = ''
  while (prefix.length + body.length + suffix.length < SIZE) {
    // xorshift32
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    body += alphabet[(state >>> 0) % 64]
  }
  return prefix + body + suffix
}

/** The gzip size of the fixture script, which the run's `scriptBytes` for the home page should grow by. */
export function heavyScriptGzipBytes(): number {
  return gzipSync(heavyScript()).length
}

/**
 * Copies `templates/astro` (without node_modules, dist and .astro) to a new directory, links its node_modules, and
 * adds the fixture script to the home page. Returns the copy's path.
 */
export function astroWithHeavyHome(repo: string): string {
  const source = join(repo, 'templates/astro')
  const copy = mkdtempSync(join(tmpdir(), 'nymbal-perf-heavy-home-'))
  cpSync(source, copy, {
    recursive: true,
    filter: (path) => !/[/\\](node_modules|dist|\.astro)([/\\]|$)/.test(path.slice(source.length)),
  })
  symlinkSync(join(source, 'node_modules'), join(copy, 'node_modules'), 'dir')

  mkdirSync(join(copy, 'public'), { recursive: true })
  writeFileSync(join(copy, 'public', FIXTURE_SCRIPT), heavyScript())

  const indexPage = join(copy, 'src/pages/index.astro')
  const page = readFileSync(indexPage, 'utf8')
  const close = page.lastIndexOf('</BaseLayout>')
  if (close < 0)
    throw new Error(`${indexPage} has no </BaseLayout>; the fixture cannot add its script`)
  writeFileSync(
    indexPage,
    `${page.slice(0, close)}  <script is:inline async src="/${FIXTURE_SCRIPT}"></script>\n${page.slice(close)}`,
  )
  return copy
}
