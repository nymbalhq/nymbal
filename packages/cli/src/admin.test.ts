import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { resolveAdminRoot } from './admin'

// P1-08 AC-11b: `NYMBAL_ADMIN_DIST` overrides the installed `@nymbalhq/admin` dist when it holds `index.html`, and is
// ignored otherwise. Kills: an env the CLI path never reads (the installed package always wins); an override taken
// without checking for `index.html`, which would serve a 404 shell instead of the installed admin.

const ENV = 'NYMBAL_ADMIN_DIST'
let tmp: string
let built: string
let unbuilt: string
const saved = process.env[ENV]

function resolveWith(value: string | undefined): string | null {
  if (value === undefined) delete process.env[ENV]
  else process.env[ENV] = value
  return resolveAdminRoot()
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'nymbal-admin-root-'))
  built = join(tmp, 'built')
  unbuilt = join(tmp, 'unbuilt')
  mkdirSync(join(built, 'assets'), { recursive: true })
  writeFileSync(join(built, 'index.html'), '<!doctype html><title>fixture</title>')
  mkdirSync(join(unbuilt, 'assets'), { recursive: true })
  writeFileSync(join(unbuilt, 'assets', 'app.js'), 'export {}')
})

afterEach(() => {
  if (saved === undefined) delete process.env[ENV]
  else process.env[ENV] = saved
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('P1-08 AC-11b: NYMBAL_ADMIN_DIST wins', () => {
  it('AC-11b: a NYMBAL_ADMIN_DIST holding index.html is returned over the installed package; one without index.html, or missing, falls back to what the installed package resolves to (else null)', () => {
    const installed = resolveWith(undefined)

    const overridden = resolveWith(built)
    expect(overridden).not.toBe(installed)
    expect(overridden).toBe(built)

    for (const dir of [unbuilt, join(tmp, 'missing')]) {
      expect(resolveWith(dir)).toBe(resolveWith(undefined))
    }
  })
})
