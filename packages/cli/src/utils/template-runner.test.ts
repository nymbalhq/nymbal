import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isFlatScaffold,
  planTemplateLaunch,
  resolveLocalBin,
  templateFilterFor,
} from './template-runner.js'

/**
 * Regression guard for the flat-scaffold launch bug.
 *
 * `nymbal dev` used to run `pnpm --filter @nymbal/template-astro dev`. In a flat
 * create-nymbal-app scaffold the project root IS the storefront and its package
 * is named after the project (e.g. `launch-smoke-astro`), so the filter matched
 * the workspace template package (the WRONG directory) inside a monorepo, or
 * nothing at all outside one. The fix runs the framework dev server directly in
 * the project root when a flat scaffold is detected.
 */
describe('template-runner', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function makeProject(opts: { configFile?: string; bins?: string[] }): string {
    const root = mkdtempSync(resolve(tmpdir(), 'nymbal-tr-'))
    dirs.push(root)
    if (opts.configFile) writeFileSync(resolve(root, opts.configFile), '')
    if (opts.bins?.length) {
      const binDir = resolve(root, 'node_modules', '.bin')
      mkdirSync(binDir, { recursive: true })
      for (const b of opts.bins) writeFileSync(resolve(binDir, b), '#!/bin/sh\n')
    }
    return root
  }

  it('maps templates to the correct workspace filter name', () => {
    expect(templateFilterFor('astro')).toBe('@nymbal/template-astro')
    expect(templateFilterFor('nextjs')).toBe('@nymbal/template-nextjs')
  })

  it('detects a flat astro scaffold by astro.config.mjs', () => {
    const root = makeProject({ configFile: 'astro.config.mjs' })
    expect(isFlatScaffold(root, 'astro')).toBe(true)
  })

  it('detects a flat next.js scaffold by next.config.mjs', () => {
    const root = makeProject({ configFile: 'next.config.mjs' })
    expect(isFlatScaffold(root, 'nextjs')).toBe(true)
  })

  it('does not treat a bare directory as a flat scaffold', () => {
    const root = makeProject({})
    expect(isFlatScaffold(root, 'astro')).toBe(false)
  })

  it('resolves a local bin when present and returns null when absent', () => {
    const root = makeProject({ bins: ['astro'] })
    expect(resolveLocalBin(root, 'astro')).toBe(resolve(root, 'node_modules', '.bin', 'astro'))
    expect(resolveLocalBin(root, 'next')).toBeNull()
  })

  it('runs the framework dev server directly in the project root for a flat astro scaffold', () => {
    const root = makeProject({ configFile: 'astro.config.mjs', bins: ['astro'] })
    const plan = planTemplateLaunch(root, 'astro', 4399)
    expect(plan.mode).toBe('flat')
    expect(plan.cwd).toBe(root)
    expect(plan.command).toBe(resolve(root, 'node_modules', '.bin', 'astro'))
    expect(plan.args).toEqual(['dev', '--port', '4399'])
    // It must NOT shell out to `pnpm --filter` (the old wrong-directory bug).
    expect(plan.command).not.toBe('pnpm')
    expect(plan.args).not.toContain('--filter')
  })

  it('passes the resolved port through to next dev for a flat next.js scaffold', () => {
    const root = makeProject({ configFile: 'next.config.mjs', bins: ['next'] })
    const plan = planTemplateLaunch(root, 'nextjs', 3007)
    expect(plan.mode).toBe('flat')
    expect(plan.command).toBe(resolve(root, 'node_modules', '.bin', 'next'))
    expect(plan.args).toEqual(['dev', '--port', '3007'])
  })

  it('throws an actionable error when a flat scaffold has no installed framework bin', () => {
    const root = makeProject({ configFile: 'astro.config.mjs' })
    expect(() => planTemplateLaunch(root, 'astro', 4399)).toThrow(/Install dependencies first/)
  })

  it('falls back to a pnpm --filter launch for a monorepo (non-flat) layout', () => {
    const root = makeProject({})
    const plan = planTemplateLaunch(root, 'astro', 4399)
    expect(plan.mode).toBe('filter')
    expect(plan.command).toBe('pnpm')
    expect(plan.args).toEqual(['--filter', '@nymbal/template-astro', 'dev'])
  })

  it('resolves the symlinked package directory (pnpm workspace) for resolveLocalBin', () => {
    // pnpm symlinks node_modules/.bin entries; resolveLocalBin must follow them.
    const root = mkdtempSync(resolve(tmpdir(), 'nymbal-tr-link-'))
    dirs.push(root)
    writeFileSync(resolve(root, 'astro.config.mjs'), '')
    const realBinDir = resolve(root, 'real-bin')
    mkdirSync(realBinDir, { recursive: true })
    const realBin = resolve(realBinDir, 'astro')
    writeFileSync(realBin, '#!/bin/sh\n')
    const binDir = resolve(root, 'node_modules', '.bin')
    mkdirSync(binDir, { recursive: true })
    symlinkSync(realBin, resolve(binDir, 'astro'))
    expect(resolveLocalBin(root, 'astro')).toBe(resolve(binDir, 'astro'))
  })
})
