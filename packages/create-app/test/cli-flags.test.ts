import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { CliFlagError, parseCliFlags } from '../src/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = resolve(HERE, '..', 'bin', 'create-nymbal-app.mjs')

/** parseCliFlags takes process.argv as is: the first two entries are node and the script. */
const argv = (...args: string[]): string[] => ['node', 'create-nymbal-app', ...args]

const TEMPLATES = ['astro', 'nextjs'] as const
const CURRENCIES = ['GBP', 'USD', 'EUR'] as const

/** A project name as a shopper types it: letters, digits and spaces, never a leading `-` (that is a flag). */
const NAME = fc.stringMatching(/^[A-Za-z0-9 ]{1,40}$/)

describe('parseCliFlags', () => {
  it('AC-2: for any name and any template, --template <v> and --template=<v> parse the same, name and template intact', () => {
    fc.assert(
      fc.property(NAME, fc.constantFrom(...TEMPLATES), (name, template) => {
        const spaced = parseCliFlags(argv(name, '--template', template, '--yes'))
        const joined = parseCliFlags(argv(name, `--template=${template}`, '--yes'))
        expect(spaced).toEqual(joined)
        expect(spaced).toEqual({ name, template, yes: true })
      }),
    )
  })

  it('AC-8: --template nextjs (CI scaffold smoke) selects nextjs and the value is not taken as the name', () => {
    const flags = parseCliFlags(argv('smoke-nextjs', '--template', 'nextjs', '--yes'))
    expect(flags).toEqual({ name: 'smoke-nextjs', template: 'nextjs', yes: true })
  })

  it('AC-8: a flag value before the positional name is not taken as the name', () => {
    const flags = parseCliFlags(argv('--template', 'nextjs', 'my-store'))
    expect(flags.template).toBe('nextjs')
    expect(flags.name).toBe('my-store')
  })

  it('AC-2: for any name and any currency, --currency <v> and --currency=<v> parse the same, name and currency intact', () => {
    fc.assert(
      fc.property(NAME, fc.constantFrom(...CURRENCIES), (name, currency) => {
        const spaced = parseCliFlags(argv(name, '--currency', currency))
        const joined = parseCliFlags(argv(name, `--currency=${currency}`))
        expect(spaced).toEqual(joined)
        expect(spaced).toEqual({ name, currency, yes: false })
      }),
    )
  })

  it('AC-2: for any name, spaces included, --name <v> and --name=<v> set the same name', () => {
    fc.assert(
      fc.property(NAME, (name) => {
        const spaced = parseCliFlags(argv('--name', name, '--yes'))
        const joined = parseCliFlags(argv(`--name=${name}`, '--yes'))
        expect(spaced).toEqual(joined)
        expect(spaced).toEqual({ name, yes: true })
      }),
    )
  })

  it('AC-8: a positional argument is the name when no --name is given', () => {
    expect(parseCliFlags(argv('my-store'))).toEqual({ name: 'my-store', yes: false })
  })

  it('AC-8: all three flags in space form together parse as their = forms do', () => {
    const spaced = parseCliFlags(
      argv('--name', 'Shop', '--template', 'nextjs', '--currency', 'USD', '-y'),
    )
    const joined = parseCliFlags(argv('--name=Shop', '--template=nextjs', '--currency=USD', '-y'))
    expect(spaced).toEqual({ name: 'Shop', template: 'nextjs', currency: 'USD', yes: true })
    expect(spaced).toEqual(joined)
  })

  it('AC-8: an unknown template, in either form, throws CliFlagError naming the value and every allowed template', () => {
    for (const args of [['--template', 'vue'], ['--template=vue']]) {
      let error: unknown
      try {
        parseCliFlags(argv('my-store', ...args))
      } catch (e) {
        error = e
      }
      expect(error).toBeInstanceOf(CliFlagError)
      const message = (error as Error).message
      expect(message).toContain('vue')
      for (const template of TEMPLATES) expect(message).toContain(template)
    }
  })

  it('AC-8: an unknown currency, in either form, throws CliFlagError naming the value and every allowed currency', () => {
    for (const args of [['--currency', 'JPY'], ['--currency=JPY']]) {
      let error: unknown
      try {
        parseCliFlags(argv('my-store', ...args))
      } catch (e) {
        error = e
      }
      expect(error).toBeInstanceOf(CliFlagError)
      const message = (error as Error).message
      expect(message).toContain('JPY')
      for (const currency of CURRENCIES) expect(message).toContain(currency)
    }
  })
})

describe('create-nymbal-app CLI', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  const run = (...args: string[]) => {
    const cwd = mkdtempSync(join(tmpdir(), 'create-nymbal-app-flags-'))
    dirs.push(cwd)
    const result = spawnSync(process.execPath, [BIN, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
    })
    return { ...result, cwd }
  }

  it('AC-8: an unknown --template exits non-zero, names the allowed templates and scaffolds nothing', () => {
    const result = run('probe', '--template', 'vue', '--yes')
    expect(result.status).not.toBe(0)
    for (const template of TEMPLATES) expect(result.stderr).toContain(template)
    expect(existsSync(join(result.cwd, 'probe'))).toBe(false)
    expect(readdirSync(result.cwd)).toEqual([])
  })

  it('AC-8: an unknown --currency exits non-zero, names the allowed currencies and scaffolds nothing', () => {
    const result = run('probe', '--currency=JPY', '--yes')
    expect(result.status).not.toBe(0)
    for (const currency of CURRENCIES) expect(result.stderr).toContain(currency)
    expect(readdirSync(result.cwd)).toEqual([])
  })
})
