import { describe, it, expect, vi } from 'vitest'
import { resolveMigrations } from './migrate.js'
import { resolve } from 'node:path'
import * as fs from 'node:fs'
import * as module from 'node:module'

vi.mock('node:fs', () => ({ existsSync: vi.fn() }))
vi.mock('node:module', () => ({ createRequire: vi.fn() }))

const mockExistsSync = vi.mocked(fs.existsSync)
const mockCreateRequire = vi.mocked(module.createRequire)

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

  it('returns published package migrations when neither local nor monorepo dir exists', () => {
    const pkgMigrations = '/project/node_modules/@nymbal/platform/migrations'
    const req = { resolve: vi.fn().mockReturnValue('/project/node_modules/@nymbal/platform/package.json') }
    mockCreateRequire.mockReturnValue(req as unknown as ReturnType<typeof module.createRequire>)
    mockExistsSync.mockImplementation((p) => p === pkgMigrations)
    expect(resolveMigrations(root)).toBe(pkgMigrations)
  })

  it('falls back to local path when nothing resolves', () => {
    const req = { resolve: vi.fn().mockImplementation(() => { throw new Error('Not found') }) }
    mockCreateRequire.mockReturnValue(req as unknown as ReturnType<typeof module.createRequire>)
    mockExistsSync.mockReturnValue(false)
    expect(resolveMigrations(root)).toBe(resolve(root, 'migrations'))
  })
})
