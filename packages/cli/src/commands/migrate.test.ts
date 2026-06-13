import { describe, it, expect, vi } from 'vitest'
import { resolveMigrations, resolvePackageDir } from './migrate.js'
import { resolve } from 'node:path'
import * as fs from 'node:fs'

vi.mock('node:fs', () => ({ existsSync: vi.fn() }))

const mockExistsSync = vi.mocked(fs.existsSync)

describe('resolveMigrations', () => {
  const root = '/project'

  it('returns local migrations/ when it exists', () => {
    mockExistsSync.mockImplementation((p) => p === resolve(root, 'migrations'))
    expect(resolveMigrations(root)).toBe(resolve(root, 'migrations'))
  })

  it('returns monorepo packages/platform/migrations when no local dir', () => {
    const monoPath = resolve(root, 'packages/platform/migrations')
    mockExistsSync.mockImplementation((p) => p === monoPath)
    expect(resolveMigrations(root)).toBe(monoPath)
  })

  it('returns installed @nymbal/platform migrations when neither local nor monorepo dir exists', () => {
    // The package dir lives at <root>/node_modules/@nymbal/platform; its
    // package.json proves the package root, and migrations/ ships inside it.
    const pkgDir = resolve(root, 'node_modules', '@nymbal/platform')
    const pkgJson = resolve(pkgDir, 'package.json')
    const pkgMigrations = resolve(pkgDir, 'migrations')
    mockExistsSync.mockImplementation((p) => p === pkgJson || p === pkgMigrations)
    expect(resolveMigrations(root)).toBe(pkgMigrations)
  })

  it('walks up to a hoisted node_modules to find the installed package', () => {
    // Deeply nested project root; @nymbal/platform is hoisted at the workspace root.
    const nested = '/workspace/apps/store'
    const pkgDir = resolve('/workspace', 'node_modules', '@nymbal/platform')
    const pkgJson = resolve(pkgDir, 'package.json')
    const pkgMigrations = resolve(pkgDir, 'migrations')
    mockExistsSync.mockImplementation((p) => p === pkgJson || p === pkgMigrations)
    expect(resolveMigrations(nested)).toBe(pkgMigrations)
  })

  it('falls back to local path when nothing resolves', () => {
    mockExistsSync.mockReturnValue(false)
    expect(resolveMigrations(root)).toBe(resolve(root, 'migrations'))
  })
})

describe('resolvePackageDir', () => {
  // Regression guard: resolution must NOT depend on the package exposing
  // `./package.json` in its exports map (it does not), nor on its ESM-only
  // main entry being CJS-resolvable. It locates node_modules/<pkg> directly.
  it('finds the package dir in the nearest node_modules', () => {
    const root = '/project'
    const pkgDir = resolve(root, 'node_modules', '@nymbal/platform')
    mockExistsSync.mockImplementation((p) => p === resolve(pkgDir, 'package.json'))
    expect(resolvePackageDir(root, '@nymbal/platform')).toBe(pkgDir)
  })

  it('walks up the tree to find a hoisted package', () => {
    const nested = '/workspace/packages/cli'
    const pkgDir = resolve('/workspace', 'node_modules', '@nymbal/platform')
    mockExistsSync.mockImplementation((p) => p === resolve(pkgDir, 'package.json'))
    expect(resolvePackageDir(nested, '@nymbal/platform')).toBe(pkgDir)
  })

  it('returns null when the package is not installed anywhere up the tree', () => {
    mockExistsSync.mockReturnValue(false)
    expect(resolvePackageDir('/project', '@nymbal/platform')).toBeNull()
  })
})
