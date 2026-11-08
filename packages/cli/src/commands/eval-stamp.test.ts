import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { GOLDEN_QUESTIONS } from '@nymbalhq/platform'
import { afterAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_THRESHOLD,
  stampFileRefusal,
  stampOf,
  stampRefusal,
  stampRunRefusal,
} from './eval-stamp.js'

// The eval stamp records a run against Anthropic's or OpenAI's own API only, and only a run that passed its threshold.

describe('stampRefusal: only a hosted provider’s own API records a stamp', () => {
  it('anthropic and openai on their own API (no baseUrl, or theirs over https) may stamp; a stand-in on 127.0.0.1, another host, plain http, a custom adapter and none may not', () => {
    const cases: Array<[{ provider: string; config?: unknown }, boolean]> = [
      [{ provider: 'anthropic', config: { apiKey: 'k' } }, true],
      [{ provider: 'anthropic' }, true],
      [{ provider: 'anthropic', config: { baseUrl: 'https://api.anthropic.com' } }, true],
      [{ provider: 'openai', config: { model: 'gpt-x' } }, true],
      [{ provider: 'openai', config: { baseUrl: 'https://api.openai.com/v1' } }, true],
      [{ provider: 'anthropic', config: { baseUrl: 'http://127.0.0.1:4010' } }, false],
      [{ provider: 'openai', config: { baseUrl: 'http://127.0.0.1:4011/v1' } }, false],
      [{ provider: 'openai', config: { baseUrl: 'http://localhost:11434/v1' } }, false],
      [{ provider: 'openai', config: { baseUrl: 'https://openrouter.ai/api/v1' } }, false],
      [{ provider: 'openai', config: { baseUrl: 'http://api.openai.com/v1' } }, false],
      [{ provider: 'anthropic', config: { baseUrl: 'not a url' } }, false],
      [{ provider: 'custom', config: {} }, false],
      [{ provider: 'none' }, false],
    ]
    expect(cases.map(([ai]) => stampRefusal(ai) === undefined)).toEqual(
      cases.map(([, allowed]) => allowed),
    )
  })
})

describe('stampRunRefusal: a stamp records a run that asked with both prompts and every tool', () => {
  const MASK = ['email', 'phone', 'address', 'postcode']
  const run: Parameters<typeof stampRunRefusal>[0] = {
    ai: { provider: 'anthropic', config: { apiKey: 'k' } },
    only: undefined,
    threshold: DEFAULT_THRESHOLD,
    customerData: true,
    mask: MASK,
  }

  it('every question at the default threshold or above, the customer tools on and the default mask in any order may stamp; --only, a lower threshold, customerData false, any other mask and a host stampRefusal refuses may not, each named', () => {
    const cases: Array<[Partial<typeof run>, string | undefined]> = [
      [{}, undefined],
      [{ threshold: DEFAULT_THRESHOLD + 1 }, undefined],
      [{ only: '' }, undefined],
      [{ mask: [...MASK].reverse() }, undefined],
      [{ only: 'books-count' }, '--stamp records a run of every question, not --only'],
      [
        { threshold: DEFAULT_THRESHOLD - 1 },
        `--stamp records a run at the default threshold (${DEFAULT_THRESHOLD}) or above`,
      ],
      [
        { threshold: 0 },
        `--stamp records a run at the default threshold (${DEFAULT_THRESHOLD}) or above`,
      ],
      [
        { customerData: false },
        '--stamp records a run with every tool offered: agents.assistant.customerData is false',
      ],
      [
        { mask: [] },
        '--stamp records a run with the default mask (email, phone, address, postcode): remove agents.assistant.mask',
      ],
      [
        { mask: ['email'] },
        '--stamp records a run with the default mask (email, phone, address, postcode): remove agents.assistant.mask',
      ],
      [
        { ai: { provider: 'anthropic', config: { baseUrl: 'http://127.0.0.1:4010' } } },
        stampRefusal({ provider: 'anthropic', config: { baseUrl: 'http://127.0.0.1:4010' } }),
      ],
    ]
    expect(cases.map(([over]) => stampRunRefusal({ ...run, ...over }))).toEqual(
      cases.map(([, refused]) => refused),
    )
    expect(cases.at(-1)![1]).toContain('api.anthropic.com')
  })
})

describe('stampFileRefusal: the stamp’s path is checked before any question is asked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nymbal-stamp-file-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('a new or existing file in an existing directory may take the stamp; a missing directory, a directory under a file and a directory as the file are refused, naming the path', () => {
    mkdirSync(join(dir, 'packages'))
    writeFileSync(join(dir, 'existing.json'), '{}\n')
    const cases: Array<[string, string | undefined]> = [
      [join(dir, 'new.json'), undefined],
      [join(dir, 'existing.json'), undefined],
      [
        join(dir, 'packages/platform/assistant-eval.json'),
        `--stamp ${join(dir, 'packages/platform/assistant-eval.json')}: there is no directory ${join(dir, 'packages/platform')} (a relative path is read from where the command runs)`,
      ],
      [
        join(dir, 'existing.json/assistant-eval.json'),
        `--stamp ${join(dir, 'existing.json/assistant-eval.json')}: there is no directory ${join(dir, 'existing.json')} (a relative path is read from where the command runs)`,
      ],
      [join(dir, 'packages'), `--stamp ${join(dir, 'packages')}: not a file`],
    ]
    expect(cases.map(([file]) => stampFileRefusal(file))).toEqual(
      cases.map(([, refused]) => refused),
    )
  })
})

describe('stampOf: a run under its threshold records nothing', () => {
  it('for any tally and threshold, a stamp is made exactly when passed reaches the threshold, and then carries the tally, threshold, hash, provider, the models once each and the run’s day', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 30 }).chain((total) =>
          fc.record({
            total: fc.constant(total),
            passed: fc.integer({ min: 0, max: total }),
            threshold: fc.integer({ min: 0, max: 30 }),
            runs: fc.integer({ min: 1, max: 9 }),
            models: fc.array(fc.constantFrom('claude-a', 'claude-b'), { maxLength: 4 }),
            date: fc.date({
              min: new Date('2026-01-01T00:00:00Z'),
              max: new Date('2030-12-31T23:59:59Z'),
              noInvalidDate: true,
            }),
          }),
        ),
        ({ total, passed, threshold, runs, models, date }) => {
          const stamp = stampOf({
            hash: 'sha256:abc',
            provider: 'anthropic',
            models,
            tally: { runs, passed, total, questions: [] },
            threshold,
            date,
          })
          expect(stamp === undefined).toBe(passed < threshold)
          if (stamp === undefined) return
          expect(stamp).toEqual({
            hash: 'sha256:abc',
            provider: 'anthropic',
            model: models.length === 0 ? null : [...new Set(models)].join(', '),
            runs,
            passed,
            total,
            threshold,
            date: date.toISOString().slice(0, 10),
          })
        },
      ),
    )
  })
})

describe('the committed stamp', () => {
  it('has the fields a stamp the eval writes has, so the release check reads a real run’s stamp as it reads the committed one', () => {
    const committed = JSON.parse(
      readFileSync(new URL('../../../platform/assistant-eval.json', import.meta.url), 'utf8'),
    ) as object
    const written = stampOf({
      hash: 'sha256:abc',
      provider: 'openai',
      models: ['gpt-x'],
      tally: {
        runs: 5,
        passed: GOLDEN_QUESTIONS.length - 1,
        total: GOLDEN_QUESTIONS.length,
        questions: [],
      },
      threshold: DEFAULT_THRESHOLD,
      date: new Date('2026-11-07T12:00:00Z'),
    })!
    expect(Object.keys(committed).sort()).toEqual(Object.keys(written).sort())
  })
})
