// Reads: stryker*.config.mjs, vitest.stryker*.config.ts, vitest.stryker.setup.ts
import { globSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REPO } from './scratch-gate'

// A property test draws new inputs on every run, so with no fixed seed a mutant it kills in one Stryker run survives
// the next and a ratchet entry set from one run fails the following one with no code changed (product.ts 82.14, then
// 81.87). Every Stryker config's Vitest config runs a setup file that fixes fast-check's seed: here each one's setup
// files are run as Vitest would run them, and fast-check must then draw the same inputs twice.

type StrykerConfig = { vitest?: { configFile?: string } }
type VitestConfig = { test?: { setupFiles?: string | string[] } }

/** Each root Stryker config with the Vitest config it runs. */
async function strykerVitestConfigs(): Promise<Array<[string, string]>> {
  const configs = globSync('stryker*.config.mjs', { cwd: REPO }).sort()
  return Promise.all(
    configs.map(async (file): Promise<[string, string]> => {
      const config = (
        (await import(pathToFileURL(join(REPO, file)).href)) as { default: StrykerConfig }
      ).default
      return [file, config.vitest?.configFile ?? 'vitest.config.ts']
    }),
  )
}

const CONFIGS = await strykerVitestConfigs()
const before = fc.readConfigureGlobal()

afterEach(() => {
  // fast-check is loaded once per worker, outside Vitest's module isolation: a seed left here would reach the next file.
  fc.configureGlobal(before)
})

describe('Stryker runs property tests at a fixed fast-check seed', () => {
  it('both Stryker configs are found', () => {
    expect(CONFIGS.map(([file]) => file)).toEqual(
      expect.arrayContaining(['stryker.config.mjs', 'stryker.integration.config.mjs']),
    )
  })

  it.each(CONFIGS)(
    '%s: its Vitest config (%s) fixes the seed, so a property draws the same inputs every run',
    async (_, vitestConfig) => {
      vi.resetModules()
      const config = (
        (await import(pathToFileURL(join(REPO, vitestConfig)).href)) as { default: VitestConfig }
      ).default
      // The config module runs in Vitest's main process, never in the workers that run the tests: a seed it sets
      // leaves Stryker's runs random, so only one a setup file sets counts.
      fc.resetConfigureGlobal()
      const setupFiles = [config.test?.setupFiles ?? []].flat()
      for (const setup of setupFiles) await import(pathToFileURL(resolve(REPO, setup)).href)

      expect(
        fc.readConfigureGlobal().seed,
        `${vitestConfig} setupFiles: ${setupFiles.join(', ')}`,
      ).toEqual(expect.any(Number))
      const draw = () => fc.sample(fc.integer(), 50)
      expect(draw()).toEqual(draw())
    },
  )
})
