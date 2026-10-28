// Reads: packages/**/src/**
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, trackedFiles } from './workspace-manifests'

// AC-17: `registerAdminStaticRoute` (packages/platform/src/routes/admin-static.ts) is the only server of the admin's
// files. No other non-test source under packages/ registers an /admin route, and routes/register.ts has no NODE_ENV
// branch for it.

const THE_ONE = 'packages/platform/src/routes/admin-static.ts'
const REGISTER = 'packages/platform/src/routes/register.ts'
const TEST_FILE = /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/
const SOURCE_FILE = /\.[cm]?[jt]sx?$/

/** A string literal that is an admin route path: '/admin', '/admin/', '/admin/*', '/admin/assets/:file' and so on. */
const ADMIN_PATH_LITERAL = /(['"`])\/admin(?:\/[\w*:.-]*)*\1/

describe('AC-17: one admin server', () => {
  const sources = trackedFiles().filter(
    (f) =>
      f.startsWith('packages/') && f.includes('/src/') && SOURCE_FILE.test(f) && !TEST_FILE.test(f),
  )

  it('AC-17: no source under packages/ other than routes/admin-static.ts names an /admin route path, and routes/register.ts has no NODE_ENV branch or monorepo-relative admin dist path', () => {
    expect(sources).toContain(THE_ONE)
    expect(sources.length, 'the scan sees more than the one file').toBeGreaterThan(1)
    const offenders = sources
      .filter((f) => f !== THE_ONE)
      .flatMap((f) =>
        readFileSync(join(REPO_ROOT, f), 'utf8')
          .split('\n')
          .map((line, i) => ({ line, at: `${f}:${i + 1}` }))
          .filter(({ line }) => ADMIN_PATH_LITERAL.test(line) && !/^\s*(?:\/\/|\*)/.test(line))
          .map(({ at, line }) => `${at}: ${line.trim()}`),
      )
    expect(offenders).toEqual([])
    expect(ADMIN_PATH_LITERAL.test(readFileSync(join(REPO_ROOT, THE_ONE), 'utf8'))).toBe(true)
    const register = readFileSync(join(REPO_ROOT, REGISTER), 'utf8')
    const code = register
      .split('\n')
      .filter((line) => !/^\s*(?:\/\/|\*)/.test(line))
      .join('\n')
    expect(code.match(/NODE_ENV/g) ?? []).toEqual([])
    expect(code.match(/apps\/admin\/dist/g) ?? []).toEqual([])
  })
})
