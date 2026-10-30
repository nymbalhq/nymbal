import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ADAPTER_CATALOGUE, PROVIDER_NAME, slotFolder } from '@nymbalhq/config'
import type { Slot } from '@nymbalhq/types'
import { knownRecipes } from '../recipes/index.js'
import { parseAddTarget } from './add.js'

// AC-1: how `nymbal add`'s positionals choose its form. One positional that is a known recipe is the recipe form, one
// that is a scoped npm package name is the package form, two are the slot form with the slot spelled as its config key
// or its folder name; anything else is an error that names the three forms.

const SLOTS = Object.keys(ADAPTER_CATALOGUE) as Slot[]
const RECIPES = knownRecipes()
const SLOT_SPELLINGS = new Set(SLOTS.flatMap((s) => [s, slotFolder(s)]))

const recipeArb = fc.constantFrom(...RECIPES)
const npmPart = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/)
const packageArb = fc.tuple(npmPart, npmPart).map(([scope, name]) => `@${scope}/${name}`)
const slotArb = fc.constantFrom(...SLOTS)
const providerArb = fc.stringMatching(PROVIDER_NAME)
/** A lone word that is no recipe, no slot and no package name. */
const strayWordArb = fc
  .stringMatching(/^[a-z][a-z0-9-]{0,20}$/)
  .filter((w) => !RECIPES.includes(w) && !SLOT_SPELLINGS.has(w))

function errorOf(result: ReturnType<typeof parseAddTarget>): string {
  if (!('error' in result)) throw new Error(`expected an error, got ${JSON.stringify(result)}`)
  return result.error
}

/** The three forms, as the help and the spec write them. */
function formsNamedBy(text: string): string[] {
  return ['<slot> <provider>', '<package>', '<recipe>'].filter((form) => text.includes(form))
}

describe('AC-1: parseAddTarget', () => {
  it('AC-1: one positional that is a known recipe is the recipe form, never a package', () => {
    fc.assert(
      fc.property(recipeArb, (name) => {
        expect(parseAddTarget([name])).toEqual({ kind: 'recipe', name })
      }),
    )
  })

  it('AC-1: one positional that is a scoped package name is the package form, with the name as given', () => {
    fc.assert(
      fc.property(packageArb, (name) => {
        expect(parseAddTarget([name])).toEqual({ kind: 'package', name })
      }),
    )
  })

  it('AC-1: two positionals are the slot form, and the kebab folder name gives the same target as the config key', () => {
    fc.assert(
      fc.property(slotArb, providerArb, (slot, provider) => {
        const byKey = parseAddTarget([slot, provider])
        expect(byKey).toEqual({ kind: 'slot', slot, provider })
        expect(parseAddTarget([slotFolder(slot), provider])).toEqual(byKey)
      }),
    )
  })

  it('AC-1: two positionals whose first is no slot and no recipe are an error naming it and every slot', () => {
    const notSlot = fc
      .stringMatching(/^[a-z][a-z0-9-]{0,20}$/)
      .filter((w) => !SLOT_SPELLINGS.has(w) && !RECIPES.includes(w))
    fc.assert(
      fc.property(notSlot, providerArb, (word, provider) => {
        const error = errorOf(parseAddTarget([word, provider]))
        expect(error).toContain(`unknown slot '${word}'`)
        const named: string[] = error.match(/[A-Za-z0-9][A-Za-z0-9-]*/g) ?? []
        const listed = SLOTS.filter((s) => named.includes(s) || named.includes(slotFolder(s)))
        expect(listed).toEqual(SLOTS)
      }),
    )
  })

  it('AC-1: no positional, three or more, or one lone word that is no recipe and holds no `/`, is an error naming the three forms', () => {
    const otherwise = fc.oneof(
      fc.constant<string[]>([]),
      strayWordArb.map((w) => [w]),
      fc.array(fc.oneof(recipeArb, packageArb, slotArb, providerArb), {
        minLength: 3,
        maxLength: 5,
      }),
    )
    fc.assert(
      fc.property(otherwise, (args) => {
        const error = errorOf(parseAddTarget(args))
        expect(formsNamedBy(error)).toEqual(['<slot> <provider>', '<package>', '<recipe>'])
      }),
    )
  })
})
