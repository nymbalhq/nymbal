// Reads: registry/adapters.json
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ROOT,
  firstPartyAdapters,
  registryDisagreements,
  type Registry,
  type RegistryEntry,
} from '../architecture/adapter-table'

// AC-3: registry/adapters.json is the one hand-pinned list of first-party adapters. The architecture project's guard
// (registryDisagreements, which adapter-layout.test.ts runs on the real workspace) fails, naming the adapter, when the
// registry lists a package the workspace lacks or the workspace holds an adapter the registry does not list. Here it
// runs in-process on the real registry and a workspace made to agree with it, then on each kind of disagreement.

const registry = JSON.parse(
  readFileSync(join(ROOT, 'registry', 'adapters.json'), 'utf8'),
) as Registry

/** The workspace as it is when it agrees with `listed`: a core package, and each adapter at its home. */
const agreeing = (listed: Registry): Array<{ name: string; dir: string }> => [
  { name: '@nymbalhq/platform', dir: 'packages/platform' },
  ...firstPartyAdapters(listed).map((a) => ({ name: a.name, dir: a.dir })),
]

const GHOST: RegistryEntry = {
  package: '@nymbalhq/search-ghost',
  slot: 'search',
  provider: 'ghost',
  tier: 'first-party',
}
const STRAY = { name: '@nymbalhq/search-stray', dir: 'packages/adapters/search/stray' }

describe('AC-3: registry/adapters.json is the one list of first-party adapters', () => {
  it('AC-3: when the registry and the workspace disagree either way, the guard names exactly the adapter in question', () => {
    const listed = firstPartyAdapters(registry)
    expect(listed.length).toBeGreaterThan(0)
    expect(registryDisagreements(listed, agreeing(registry))).toEqual([])

    // A first-party entry with no package behind it.
    const withGhost = { adapters: [...registry.adapters, GHOST] }
    const listedOnly = registryDisagreements(firstPartyAdapters(withGhost), agreeing(registry))
    // A workspace adapter with no entry.
    const unlisted = registryDisagreements(listed, [...agreeing(registry), STRAY])
    // A listed home holding a package under another name.
    const renamed = listed[0]!
    const misnamed = registryDisagreements(
      listed,
      agreeing(registry).map((m) =>
        m.dir === renamed.dir ? { ...m, name: '@nymbalhq/not-its-name' } : m,
      ),
    )

    expect(listedOnly).toHaveLength(1)
    expect(listedOnly[0]).toContain('@nymbalhq/search-ghost')
    expect(listedOnly[0]).toContain('packages/adapters/search/ghost')
    expect(unlisted).toHaveLength(1)
    expect(unlisted[0]).toContain(STRAY.name)
    expect(unlisted[0]).toContain(STRAY.dir)
    expect(misnamed).toHaveLength(1)
    expect(misnamed[0]).toContain(renamed.name)
    expect(misnamed[0]).toContain('@nymbalhq/not-its-name')
    // Each disagreement is reported apart from the others: both at once are the two alone.
    expect(
      registryDisagreements(firstPartyAdapters(withGhost), [...agreeing(registry), STRAY]).sort(),
    ).toEqual([...listedOnly, ...unlisted].sort())
  })
})
