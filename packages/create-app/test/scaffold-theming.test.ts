import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scaffold } from '../src/index.js'

// AC-7: a project made by `create-nymbal-app` (`scaffold()`, as scaffold.test.ts makes one) is byte-identical to
// the synced template, except the paths the project layer (scaffold/project/<template>) lists. The rest of what
// scaffold() itself writes is outside the comparison by design: package.json (its name is patched), nymbal.config.ts
// (rendered from the answers), and the root `_dot.*` files, which arrive as `.*` with the same bytes. The template's
// own tokens.css and elements entry are among the identical files, so the project owns them from its first commit.

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const SCAFFOLD_TEMPLATES = resolve(PKG_ROOT, 'scaffold', 'templates')
const PROJECT_LAYER = resolve(PKG_ROOT, 'scaffold', 'project')
const WRITTEN_BY_SCAFFOLD = new Set(['package.json', 'nymbal.config.ts'])

const THEMING_FILES: Record<'astro' | 'nextjs', string[]> = {
  astro: ['src/styles/tokens.css', 'src/elements/index.ts'],
  nextjs: ['app/tokens.css', 'elements/index.ts'],
}

/** Every file under `dir`, relative to it, node_modules aside. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && !relative(dir, e.parentPath).split('/').includes('node_modules'))
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort()
}

/** Where a synced template file lands in the project: a root `_dot.x` is renamed `.x`. */
function landing(rel: string): string {
  return !rel.includes('/') && rel.startsWith('_dot.') ? `.${rel.slice('_dot.'.length)}` : rel
}

const tmpBase = resolve(PKG_ROOT, 'test', '.tmp-scaffold-theming')

afterAll(() => {
  rmSync(tmpBase, { recursive: true, force: true })
})

for (const tmpl of ['astro', 'nextjs'] as const) {
  describe(`AC-7: the ${tmpl} scaffold is the synced template plus the project layer`, () => {
    let outDir: string

    beforeAll(async () => {
      outDir = resolve(tmpBase, tmpl)
      rmSync(outDir, { recursive: true, force: true })
      await scaffold(outDir, {
        name: 'Theming Store',
        directory: tmpl,
        currency: 'GBP',
        template: tmpl,
        seedDemo: false,
      })
    })

    it(`AC-7: every ${tmpl} file outside the project layer is byte-identical to the synced template, the project adds no other file, and tokens.css and the elements entry are among the identical`, () => {
      const synced = filesUnder(resolve(SCAFFOLD_TEMPLATES, tmpl))
      const listed = new Set(filesUnder(resolve(PROJECT_LAYER, tmpl)))
      const compared = synced.filter((rel) => !listed.has(rel) && !WRITTEN_BY_SCAFFOLD.has(rel))
      expect(compared.length).toBeGreaterThan(listed.size)

      const identical = compared.filter((rel) => {
        const project = resolve(outDir, landing(rel))
        return (
          existsSync(project) &&
          readFileSync(project).equals(readFileSync(resolve(SCAFFOLD_TEMPLATES, tmpl, rel)))
        )
      })
      expect(
        compared.filter((rel) => !identical.includes(rel)),
        'differ from the synced template',
      ).toEqual([])

      // Nothing else arrives: the project is the compared files, the project layer and what scaffold() writes.
      const expectedFiles = new Set([...compared.map(landing), ...listed, ...WRITTEN_BY_SCAFFOLD])
      expect(filesUnder(outDir).filter((rel) => !expectedFiles.has(rel))).toEqual([])

      expect(
        THEMING_FILES[tmpl].filter((rel) => !identical.includes(rel)),
        `${tmpl}: the project-owned tokens and elements entry arrive identical to the template`,
      ).toEqual([])
      // And the synced template is the template itself for them (the sync is not skipped).
      for (const rel of THEMING_FILES[tmpl]) {
        const source = resolve(PKG_ROOT, '..', '..', 'templates', tmpl, rel)
        expect(existsSync(source), `templates/${tmpl}/${rel}`).toBe(true)
        expect(readFileSync(resolve(outDir, rel), 'utf8')).toBe(readFileSync(source, 'utf8'))
      }
    })
  })
}
