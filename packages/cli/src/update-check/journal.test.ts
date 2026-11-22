import { readFileSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { addedMigrations, type Journals, publishedJournals } from './journal.js'

// The migrations an update adds, read from the Drizzle journals of @nymbalhq/platform: those installed at the head
// against those of the published base version, fetched from an npm registry as a packument and its gzipped tarball.
// The registry here is an in-process fake serving a tarball built in the test.

const PLATFORM = '@nymbalhq/platform'
const VERSION = '1.8.0'

const repoJournal = (dialect: 'sqlite' | 'postgres'): string[] =>
  (
    JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(`../../../platform/migrations/${dialect}/meta/_journal.json`, import.meta.url),
        ),
        'utf8',
      ),
    ) as { entries: Array<{ tag: string }> }
  ).entries.map((e) => e.tag)

// ─── AC-6 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const tagsOf = (ns: number[], word: string) =>
  ns.map((n) => `${String(n).padStart(4, '0')}_${word}`)

/** A base journal (the same tags in both dialects) and k new tags, all distinct. */
const baseAndAdded = fc.uniqueArray(fc.nat(9999), { maxLength: 24 }).chain((ns) =>
  fc.nat(ns.length).map((split) => ({
    base: tagsOf(ns.slice(0, split), 'base'),
    added: tagsOf(ns.slice(split), 'added'),
  })),
)

describe('AC-6: addedMigrations', () => {
  it("AC-6: this repository's own journals against themselves add nothing, and against one more tag add exactly it", () => {
    const journals: Journals = { sqlite: repoJournal('sqlite'), postgres: repoJournal('postgres') }
    const next: Journals = {
      sqlite: [...journals.sqlite, '0029_x'],
      postgres: [...journals.postgres, '0029_x'],
    }

    expect(addedMigrations(journals, journals)).toEqual([])
    expect(addedMigrations(journals, next)).toEqual(['0029_x'])
  })

  it('AC-6: a head extending the base by k entries in sqlite, postgres or both gives exactly those k tags, in order, once each (property)', () => {
    fc.assert(
      fc.property(
        baseAndAdded,
        fc.constantFrom('sqlite', 'postgres', 'both'),
        ({ base, added }, where) => {
          const before: Journals = { sqlite: base, postgres: [...base] }
          const after: Journals = {
            sqlite: where === 'postgres' ? [...base] : [...base, ...added],
            postgres: where === 'sqlite' ? [...base] : [...base, ...added],
          }

          expect(addedMigrations(before, after)).toEqual(added)
        },
      ),
    )
  })

  it('AC-6: new tags spread over the two dialects, some in one only, are each reported exactly once (property)', () => {
    fc.assert(
      fc.property(
        baseAndAdded.chain(({ base, added }) =>
          fc
            .array(fc.constantFrom('sqlite', 'postgres', 'both'), {
              minLength: added.length,
              maxLength: added.length,
            })
            .map((where) => ({ base, added, where })),
        ),
        ({ base, added, where }) => {
          const after: Journals = {
            sqlite: [...base, ...added.filter((_, i) => where[i] !== 'postgres')],
            postgres: [...base, ...added.filter((_, i) => where[i] !== 'sqlite')],
          }

          const result = addedMigrations({ sqlite: base, postgres: [...base] }, after)

          expect(new Set(result).size).toBe(result.length)
          expect([...result].sort()).toEqual([...added].sort())
        },
      ),
    )
  })
})

// ─── AC-7 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One ustar header block: name, mode, ids, octal size, mtime, checksum, type (a regular file by default), prefix. */
function header(name: string, size: number, type = '0', prefix = ''): Buffer {
  const h = Buffer.alloc(512)
  h.write(name, 0, 100, 'utf8')
  h.write('0000644\0', 100)
  h.write('0000000\0', 108)
  h.write('0000000\0', 116)
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  h.write('00000000000\0', 136)
  h.write('        ', 148)
  h.write(type, 156)
  h.write('ustar\0', 257)
  h.write('00', 263)
  h.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const byte of h) sum += byte
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return h
}

/** Entries as [name, body] or [name, body, type, prefix]: a long path splits into prefix and name. */
function tarball(files: Array<[string, string] | [string, string, string, string]>): Buffer {
  const blocks: Buffer[] = []
  for (const [name, body, type, prefix] of files) {
    const data = Buffer.from(body)
    blocks.push(header(name, data.length, type, prefix), data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

const journalJson = (dialect: string, tags: string[]) =>
  JSON.stringify(
    {
      version: '7',
      dialect,
      entries: tags.map((tag, idx) => ({
        idx,
        version: '6',
        when: 1776875073175 + idx,
        tag,
        breakpoints: true,
      })),
    },
    null,
    2,
  )

const PUBLISHED: Journals = {
  sqlite: ['0000_glorious_vision', '0001_tricky_glorian', '0028_tax_columns'],
  postgres: ['0000_glorious_vision', '0001_tricky_glorian', '0027_pg_only', '0028_tax_columns'],
}

/**
 * The package as npm packs it: other files first, at sizes that are not a multiple of 512, a pax extended header
 * before the sqlite journal, and the postgres journal's path split between the ustar prefix and name fields.
 */
const GOOD_TARBALL = tarball([
  ['package/package.json', JSON.stringify({ name: PLATFORM, version: VERSION })],
  ['package/dist/index.js', `export const x = ${JSON.stringify('y'.repeat(700))}\n`],
  ['package/migrations/sqlite/0000_glorious_vision.sql', 'CREATE TABLE t (id integer);\n'],
  ['package/migrations/sqlite/meta/PaxHeader/_journal.json', '20 mtime=1776875073\n', 'x', ''],
  ['package/migrations/sqlite/meta/_journal.json', journalJson('sqlite', PUBLISHED.sqlite)],
  [
    'meta/_journal.json',
    journalJson('postgresql', PUBLISHED.postgres),
    '0',
    'package/migrations/postgres',
  ],
])

interface FakeRegistry {
  url: string
}

interface RegistryOptions {
  packumentStatus?: number
  versions?: string[]
  tarballStatus?: number
  tarballBody?: Buffer
  silent?: boolean
}

let cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

async function registry(options: RegistryOptions = {}): Promise<FakeRegistry> {
  let base = ''
  const server: Server = createServer((req, res: ServerResponse) => {
    const path = decodeURIComponent((req.url ?? '').replace(/^\/+/, ''))
    if (options.silent) return
    if (path === PLATFORM) {
      if (options.packumentStatus !== undefined) {
        res.writeHead(options.packumentStatus).end('{"error":"Not found"}')
        return
      }
      const versions = Object.fromEntries(
        (options.versions ?? [VERSION]).map((v) => [
          v,
          {
            name: PLATFORM,
            version: v,
            dist: { tarball: `${base}tarballs/platform-${v}.tgz` },
          },
        ]),
      )
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: PLATFORM, versions }))
      return
    }
    if (path.startsWith('tarballs/')) {
      if (options.tarballStatus !== undefined) {
        res.writeHead(options.tarballStatus).end('oops')
        return
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(options.tarballBody ?? GOOD_TARBALL)
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  const { port } = server.address() as { port: number }
  base = `http://127.0.0.1:${port}/`
  return { url: base }
}

describe('AC-7: publishedJournals reads the base version from the registry, and every failure rejects', () => {
  it("AC-7: the packument's tarball, gunzipped and walked, gives both dialects' tags in journal order", async () => {
    const fake = await registry()

    const journals = await publishedJournals(PLATFORM, VERSION, { registry: fake.url })

    expect(journals).toEqual(PUBLISHED)
  })

  it.each([
    { step: 'a 404 packument', options: { packumentStatus: 404 }, names: /404/ },
    {
      step: 'a version the packument does not hold',
      options: { versions: ['1.7.0'] },
      names: /1\.8\.0/,
    },
    {
      step: 'a 500 tarball',
      options: { tarballStatus: 500 },
      names: /tarball[^]*500|500[^]*tarball/i,
    },
    {
      step: 'a tarball that is not gzip',
      options: { tarballBody: Buffer.from('this is not gzip at all') },
      names: /gzip|gunzip|tarball/i,
    },
    {
      step: 'a tar without the journals',
      options: {
        tarballBody: tarball([['package/package.json', JSON.stringify({ name: PLATFORM })]]),
      },
      names: /journal/i,
    },
  ])('AC-7: $step rejects with an Error naming that step', async ({ options, names }) => {
    const fake = await registry(options)

    await expect(
      publishedJournals(PLATFORM, VERSION, { registry: fake.url, timeoutMs: 2_000 }),
    ).rejects.toThrow(names)
  })

  it('AC-7: a registry that never answers rejects within timeoutMs plus one second', async () => {
    const fake = await registry({ silent: true })
    const timeoutMs = 300
    const started = performance.now()

    await expect(
      publishedJournals(PLATFORM, VERSION, { registry: fake.url, timeoutMs }),
    ).rejects.toThrow(/time|abort/i)

    expect(performance.now() - started).toBeLessThan(timeoutMs + 1_000)
  })

  it('AC-7: with registry unset it reads from npm_config_registry', async () => {
    const fake = await registry()
    const saved = process.env['npm_config_registry']
    process.env['npm_config_registry'] = fake.url
    try {
      const journals = await publishedJournals(PLATFORM, VERSION, { timeoutMs: 2_000 })

      expect(journals).toEqual(PUBLISHED)
    } finally {
      if (saved === undefined) delete process.env['npm_config_registry']
      else process.env['npm_config_registry'] = saved
    }
  })
})
