import { mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A store project on disk, for a test whose kernel or CLI runs with the project as its working directory and so
// resolves adapter packages from the project's own node_modules. `installed` maps a package name to what stands in for
// it there: a package directory (a workspace adapter, a fixture package) is linked as it is; a single module file
// becomes a package whose only export is that file, under the `import` condition.

const REPO = fileURLToPath(new URL('../../', import.meta.url))

/** The workspace directory of a first-party package: the one the kernel's own node_modules links. */
export function workspacePackage(name: string): string {
  return realpathSync(join(REPO, 'packages', 'platform', 'node_modules', ...name.split('/')))
}

/** `names`, each to be installed as its workspace package. */
export function workspace(...names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, workspacePackage(name)]))
}

/** Puts each of `installed` (name to package directory or module file) into `dir`'s node_modules. */
export function install(dir: string, installed: Record<string, string>): void {
  for (const [name, target] of Object.entries(installed)) {
    const at = join(dir, 'node_modules', ...name.split('/'))
    if (statSync(target).isDirectory()) {
      mkdirSync(join(at, '..'), { recursive: true })
      symlinkSync(target, at, 'dir')
      continue
    }
    const entry = `./index${extname(target)}`
    mkdirSync(at, { recursive: true })
    writeFileSync(
      join(at, 'package.json'),
      `${JSON.stringify({ name, version: '1.0.0', type: 'module', exports: { '.': { import: entry } } }, null, 2)}\n`,
    )
    symlinkSync(target, join(at, entry), 'file')
  }
}

/**
 * A new store project under `parent` (the system temp directory by default), with a package.json and `installed` in
 * its node_modules. The caller removes it.
 */
export function project(
  installed: Record<string, string> = {},
  options: { parent?: string; prefix?: string } = {},
): string {
  const dir = mkdtempSync(join(options.parent ?? tmpdir(), options.prefix ?? 'nymbal-project-'))
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'test-store', private: true, type: 'module' }, null, 2)}\n`,
  )
  install(dir, installed)
  return dir
}
