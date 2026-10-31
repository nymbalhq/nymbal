import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  ADAPTER_CATALOGUE,
  BUILT_IN,
  conventionPackage,
  KNOWN_PROVIDERS,
  PROVIDER_NAME,
  slotFolder,
  type Slot,
} from './index.js'

// AC-3, the unit half: a slot and a provider name one package, `@nymbalhq/<kebab slot>-<provider>`, a valid npm name
// for every slot and every provider name; the catalogue's built-ins are BUILT_IN, and KNOWN_PROVIDERS is the commerce
// catalogue plus `custom`, with the values it had. The workspace half is tests/architecture/adapter-names.test.ts.

const COMMERCE = [
  'payments',
  'email',
  'reviews',
  'search',
  'analytics',
  'shipping',
  'tax',
  'ai',
] as const
const SLOTS: readonly Slot[] = [...COMMERCE, 'documentStore', 'eventBus', 'media', 'security']

/** The commerce providers the config knew before the catalogue, and those added since, `custom` aside. */
const KNOWN_BEFORE: Record<(typeof COMMERCE)[number], readonly string[]> = {
  payments: ['native', 'stripe'],
  email: ['native', 'smtp', 'mailgun', 'resend', 'ses'],
  ai: ['none', 'anthropic'],
  reviews: ['native'],
  search: ['native', 'algolia'],
  analytics: ['native'],
  shipping: ['native', 'easypost'],
  tax: ['native'],
}

/** The kernel's own provider of each slot. */
const KERNEL_OWN: Record<Slot, readonly string[]> = {
  ...Object.fromEntries(COMMERCE.map((s) => [s, s === 'ai' ? ['none'] : ['native']])),
  documentStore: ['in-memory'],
  eventBus: ['in-process'],
  media: ['local-fs'],
  security: ['middleware'],
} as unknown as Record<Slot, readonly string[]>

/** A kebab folder back to the camel-case key it came from. */
const camel = (folder: string): string =>
  folder.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

/** npm's rules for a scoped name: lower case, URL-safe, no leading `.` or `_` in either part, at most 214 characters. */
const isNpmName = (name: string): boolean =>
  name.length <= 214 &&
  /^@[a-z0-9~-][a-z0-9._~-]*\/[a-z0-9~-][a-z0-9._~-]*$/.test(name) &&
  encodeURIComponent(name.slice(1).replace('/', '')) === name.slice(1).replace('/', '')

/** A catalogue entry, as the interface declares it. */
type CatalogueEntry = { builtIn?: true; sdk?: string }
const entriesOf = (slot: Slot): Array<[string, CatalogueEntry]> =>
  Object.entries(ADAPTER_CATALOGUE[slot] as Readonly<Record<string, CatalogueEntry>>)

const providerName = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,40}$/)

describe('AC-3: a slot and a provider name one package', () => {
  it('AC-3: slotFolder is the kebab case of every slot, and reads back to the slot it came from', () => {
    const folders = SLOTS.map((slot) => [slot, slotFolder(slot)] as const)

    expect(folders.filter(([, folder]) => !/^[a-z]+(-[a-z]+)*$/.test(folder))).toEqual([])
    expect(folders.filter(([slot, folder]) => camel(folder) !== slot)).toEqual([])
    expect(slotFolder('documentStore')).toBe('document-store')
    expect(slotFolder('eventBus')).toBe('event-bus')
  })

  it('AC-3: PROVIDER_NAME accepts exactly the lower-case names of letters, digits and hyphens that start with a letter or digit', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          providerName,
          fc.string({ maxLength: 12 }),
          fc.constantFrom('Stripe', '../x', '-x', 'a_b', 'a.b', '@acme/x', ''),
        ),
        (name) => {
          expect(PROVIDER_NAME.test(name), JSON.stringify(name)).toBe(
            /^[a-z0-9][a-z0-9-]*$/.test(name),
          )
        },
      ),
      { numRuns: 300 },
    )
  })

  it('AC-3: for every slot and every provider name, conventionPackage is @nymbalhq/<slotFolder>-<provider>, a valid npm name', () => {
    fc.assert(
      fc.property(fc.constantFrom(...SLOTS), providerName, (slot, provider) => {
        const name = conventionPackage(slot, provider)

        expect(name).toBe(`@nymbalhq/${slotFolder(slot)}-${provider}`)
        expect(isNpmName(name), name).toBe(true)
      }),
      { numRuns: 300 },
    )
  })
})

describe('AC-3: the catalogue is the one list of providers', () => {
  it('AC-3: the catalogue has every slot, and BUILT_IN is its built-in entries, the kernel’s own provider of each slot', () => {
    expect(Object.keys(ADAPTER_CATALOGUE).sort()).toEqual([...SLOTS].sort())
    for (const slot of SLOTS) {
      const marked = entriesOf(slot)
        .filter(([, entry]) => entry.builtIn === true)
        .map(([name]) => name)
      expect([...BUILT_IN[slot]].sort(), slot).toEqual(marked.sort())
      expect([...BUILT_IN[slot]].sort(), slot).toEqual([...KERNEL_OWN[slot]].sort())
    }
  })

  it('AC-3: a built-in has no SDK to install', () => {
    const withSdk = SLOTS.flatMap((slot) =>
      entriesOf(slot)
        .filter(([, entry]) => entry.builtIn === true && entry.sdk !== undefined)
        .map(([name]) => `${slot}.${name}`),
    )
    expect(withSdk).toEqual([])
  })

  it('AC-3: KNOWN_PROVIDERS is each commerce slot’s catalogue names plus custom, the values it had before', () => {
    expect(Object.keys(KNOWN_PROVIDERS).sort()).toEqual([...COMMERCE].sort())
    for (const slot of COMMERCE) {
      const known = [...KNOWN_PROVIDERS[slot]].sort()
      expect(known, slot).toEqual([...Object.keys(ADAPTER_CATALOGUE[slot]), 'custom'].sort())
      expect(known, slot).toEqual([...KNOWN_BEFORE[slot], 'custom'].sort())
    }
  })
})
