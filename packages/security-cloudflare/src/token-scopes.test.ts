import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CREDENTIALS_HINT } from './client.js'

// AC-9: the token scopes a store's owner is told, wherever they are told them (the refused credentials hint, the
// recipe's CLOUDFLARE_API_TOKEN comment and its next steps), are the same three: Zone › Zone › Read, Zone › Zone WAF ›
// Edit and Zone › Cache Rules › Edit. `nymbal add cloudflare`'s printed next steps are packages/cli's add.test.ts AC-9.

interface Recipe {
  env: Array<{ name: string; comment?: string }>
  next: string[]
}

const recipe = JSON.parse(
  readFileSync(new URL('../recipes/cloudflare.json', import.meta.url), 'utf8'),
) as Recipe

/** Each `Zone › <group> › <Read|Edit>` a text names, normalised and sorted. */
function scopes(text: string): string[] {
  const found = [...text.matchAll(/Zone\s*›\s*([A-Za-z][A-Za-z ]*?)\s*›\s*(Read|Edit)\b/g)].map(
    (m) => `Zone › ${m[1]!.trim()} › ${m[2]!}`,
  )
  return [...new Set(found)].sort()
}

const WANTED = ['Zone › Cache Rules › Edit', 'Zone › Zone WAF › Edit', 'Zone › Zone › Read']

describe('AC-9: the token scopes name Cache Rules Edit', () => {
  it('AC-9: CREDENTIALS_HINT, the recipe’s CLOUDFLARE_API_TOKEN comment and its next steps each name Zone › Cache Rules › Edit beside Zone › Zone › Read and Zone › Zone WAF › Edit, and the same scopes', () => {
    const comment = recipe.env.find((e) => e.name === 'CLOUDFLARE_API_TOKEN')?.comment ?? ''
    const next = recipe.next.join('\n')

    expect(scopes(CREDENTIALS_HINT), 'CREDENTIALS_HINT').toEqual(WANTED)
    expect(scopes(comment), 'the recipe’s token comment').toEqual(scopes(CREDENTIALS_HINT))
    expect(scopes(next), 'the recipe’s next steps').toEqual(scopes(CREDENTIALS_HINT))
  })
})
