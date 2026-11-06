import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiAdapter } from '@nymbalhq/types'
import {
  startAiStandIn,
  type AiStandIn,
  type AiWire,
} from '../../../../tests/support/ai-stand-in.js'
import {
  cleanups,
  newSecretsKey,
  openStore,
  putSetting,
  SECRETS_KEY,
  setEnv,
  settingsConfig,
  type Store,
} from '../support/settings.js'

// The ai slot through createApp on SQLite, with each provider's stand-in (tests/support/ai-stand-in.ts) at the block's
// baseUrl.
// - AC-10: the same store booted with `ai: anthropic` and then with only the ai block changed to `openai`: the slot's
//   provider follows the config, @nymbalhq/ai-openai loads by its convention name, eval E2 passes through
//   app.adapters.ai.chat on both, and each stand-in sees only its own run's requests.
// - AC-11, per provider: with no key in the config or the environment chat() refuses `adapter.not_configured` and the
//   stand-in sees nothing; after the admin saves ai.apiKey and the store starts again the stand-in sees that key; with
//   the provider's env variable then exported, the env's key is the one sent.

const ENV_OF: Record<AiWire, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
}
const MODEL = 'gpt-stand-in'

const scope = cleanups()
afterEach(() => scope.run())

/** The ai block for `wire` with its stand-in at the declared baseUrl, and `apiKey` only when given. */
function aiBlock(wire: AiWire, standIn: AiStandIn, apiKey?: string) {
  const key = apiKey === undefined ? {} : { apiKey }
  return wire === 'anthropic'
    ? { provider: 'anthropic', config: { baseUrl: standIn.url, ...key } }
    : { provider: 'openai', config: { baseUrl: `${standIn.url}/v1`, model: MODEL, ...key } }
}

async function begin(): Promise<string> {
  scope.add(
    setEnv({
      [SECRETS_KEY]: newSecretsKey(),
      ANTHROPIC_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    }),
  )
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-'))
  scope.add(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'store.sqlite')
}

async function standIn(wire: AiWire): Promise<AiStandIn> {
  const started = await startAiStandIn(wire)
  scope.add(() => started.close())
  return started
}

async function boot(target: string, ai: Record<string, unknown>): Promise<Store> {
  const store = await openStore({
    dialect: 'sqlite',
    target,
    config: settingsConfig('sqlite', { ai }),
  })
  scope.add(() => store.stop())
  return store
}

function aiOf(store: Store): AiAdapter {
  const ai = store.app.adapters.ai
  expect(ai, 'the ai slot is empty').not.toBeNull()
  return ai!
}

/** Eval E2 through the slot's chat(): the code word, and what the adapter answered. */
async function evalE2(ai: AiAdapter): Promise<{ word: string; text: string }> {
  const word = `lantern${Math.floor(Math.random() * 900 + 100)}`
  const result = await ai.chat([
    { role: 'user', content: `The code word is ${word}.` },
    { role: 'assistant', content: 'Noted.' },
    { role: 'user', content: 'What is the code word? Reply with the word only.' },
  ])
  return { word, text: result.text }
}

describe('AC-10: the provider follows the ai block, and nothing else changes', () => {
  it('AC-10: anthropic and then openai with only the ai block changed: providerName follows the config, E2 passes through app.adapters.ai.chat on both, and each stand-in sees only its own run', async () => {
    const target = await begin()
    const anthropic = await standIn('anthropic')
    const openai = await standIn('openai')
    const keys = { anthropic: `sk-ant-${randomUUID()}`, openai: `sk-${randomUUID()}` }
    const runs: Array<{ provider: string; word: string; text: string; seen: [number, number] }> = []

    for (const wire of ['anthropic', 'openai'] as const) {
      const store = await boot(
        target,
        aiBlock(wire, wire === 'anthropic' ? anthropic : openai, keys[wire]),
      )
      const ai = aiOf(store)
      const { word, text } = await evalE2(ai)
      runs.push({
        provider: ai.providerName,
        word,
        text,
        seen: [anthropic.requests.length, openai.requests.length],
      })
      await store.stop()
    }

    expect(runs.map((r) => r.provider)).toEqual(['anthropic', 'openai'])
    expect(runs.map((r) => r.text.includes(r.word))).toEqual([true, true])
    expect(runs.map((r) => r.seen)).toEqual([
      [1, 0],
      [1, 1],
    ])
    expect(anthropic.credentials()).toEqual([keys.anthropic])
    expect(openai.credentials()).toEqual([keys.openai])
  }, 60_000)
})

describe.each(['anthropic', 'openai'] as const)(
  'AC-11: a key saved in Settings reaches %s chat() after a restart, and the environment outranks it',
  (wire) => {
    it(`AC-11: ${wire} with no key refuses adapter.not_configured and sends nothing; the saved ai.apiKey is sent after a restart; ${ENV_OF[wire]} then outranks it`, async () => {
      const target = await begin()
      const provider = await standIn(wire)
      const saved = `saved-${wire}-${randomUUID()}`
      const exported = `exported-${wire}-${randomUUID()}`
      const ask = (ai: AiAdapter) =>
        ai.chat([{ role: 'user', content: 'Reply with exactly the word PONG.' }])

      const unkeyed = await boot(target, aiBlock(wire, provider))
      const refused = await ask(aiOf(unkeyed)).then(
        () => 'resolved',
        (error: { code?: unknown }) => error.code,
      )
      expect(refused).toBe('adapter.not_configured')
      expect(provider.requests).toHaveLength(0)
      const put = await putSetting(await unkeyed.admin(), 'ai', 'apiKey', saved)
      expect(put.status, JSON.stringify(put.body)).toBe(200)
      await unkeyed.stop()

      const fromSettings = await boot(target, aiBlock(wire, provider))
      const answered = await ask(aiOf(fromSettings))
      expect(answered.text).toContain('PONG')
      expect(answered.text).toBe(provider.answers.at(-1)!.text)
      await fromSettings.stop()

      scope.add(setEnv({ [ENV_OF[wire]]: exported }))
      const fromEnv = await boot(target, aiBlock(wire, provider))
      await ask(aiOf(fromEnv))
      await fromEnv.stop()

      expect(provider.credentials()).toEqual([saved, exported])
    }, 60_000)
  },
)
