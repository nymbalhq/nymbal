import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CREDENTIALS_HINT } from './client.js'

// The token scopes a store's owner is told, wherever they are told them (the refused credentials hint, the recipe's
// CLOUDFLARE_API_TOKEN comment and its token step), are the same four: Zone › Zone › Read, Zone › Zone WAF › Edit,
// Zone › Cache Rules › Edit and Zone › Transform Rules › Edit (the origin lock's header rule; without it the first apply
// is refused at that phase). The next steps say security:apply creates NYMBAL_ORIGIN_SECRET, to be set on the host
// after. `nymbal add cloudflare`'s printed next steps are packages/cli's add.test.ts AC-9.

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

const WANTED = [
  'Zone › Cache Rules › Edit',
  'Zone › Transform Rules › Edit',
  'Zone › Zone WAF › Edit',
  'Zone › Zone › Read',
]

describe('AC-10: the token scopes name Transform Rules Edit', () => {
  it('AC-10: CREDENTIALS_HINT, the recipe’s CLOUDFLARE_API_TOKEN comment and its token step each name exactly Zone › Zone › Read, Zone › Zone WAF › Edit, Zone › Cache Rules › Edit and Zone › Transform Rules › Edit', () => {
    const comment = recipe.env.find((e) => e.name === 'CLOUDFLARE_API_TOKEN')?.comment ?? ''
    const tokenSteps = recipe.next.filter((step) => scopes(step).length > 0)

    expect(scopes(CREDENTIALS_HINT), 'CREDENTIALS_HINT').toEqual(WANTED)
    expect(scopes(comment), 'the recipe’s token comment').toEqual(scopes(CREDENTIALS_HINT))
    expect(tokenSteps.map(scopes), 'the recipe’s token step').toEqual([scopes(CREDENTIALS_HINT)])
  })

  it('AC-10: the next steps say nymbal security:apply creates NYMBAL_ORIGIN_SECRET and to set it on the host after, and none names a hop count', () => {
    const secretSteps = recipe.next.filter(
      (step) => step.includes('nymbal security:apply') && step.includes('NYMBAL_ORIGIN_SECRET'),
    )
    const hopSteps = recipe.next.filter((step) => /\bhops?\b|TRUST_PROXY_HOPS/i.test(step))

    expect(secretSteps.map((step) => /\bhost\b/i.test(step))).toEqual([true])
    expect(hopSteps).toEqual([])
  })
})
