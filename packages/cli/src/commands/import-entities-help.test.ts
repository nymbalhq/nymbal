import { describe, expect, it } from 'vitest'
import { importCommand } from './import.js'

// The help a merchant reads for `nymbal import --entities`, from the exported command definition.

const ENTITIES = ['categories', 'products', 'customers', 'orders', 'reviews']

/** The `--entities` help: the text before `(default: …)`, and the comma-separated names it states as the default. */
async function entitiesHelp(): Promise<{ listed: string; defaults: string[] }> {
  const args =
    typeof importCommand.args === 'function' ? await importCommand.args() : await importCommand.args
  const description = args?.entities?.description ?? ''
  const stated = /\(default:\s*([^)]*)\)/i.exec(description)
  return {
    listed: stated === null ? description : description.slice(0, stated.index),
    defaults: (stated?.[1] ?? '')
      .split(',')
      .map((e) => e.trim())
      .filter((e) => e !== ''),
  }
}

describe('nymbal import --entities help', () => {
  it('AC-7: the --entities help names each of the five entities the flag takes, and states categories, products, customers, orders as its default, each one of them', async () => {
    const { listed, defaults } = await entitiesHelp()

    for (const e of ENTITIES) expect([e, new RegExp(`\\b${e}\\b`).test(listed)]).toEqual([e, true])
    expect(defaults.filter((d) => ENTITIES.includes(d))).toEqual(defaults)
    expect(defaults).toEqual(['categories', 'products', 'customers', 'orders'])
  })
})
