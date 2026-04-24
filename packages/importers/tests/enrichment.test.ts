import { describe, it, expect, vi } from 'vitest'
import { isThinContent } from '../src/woocommerce/mappers/product.js'
import { enrichProduct, runEnrichment } from '../src/woocommerce/enrichment.js'
import type { AiAdapter } from '@nymbal/types'
import type { ProductService } from '@nymbal/platform'

function makeAiAdapter(responseText: string): AiAdapter {
  return {
    kind: 'ai',
    providerName: 'test',
    capabilities: ['complete'],
    producesEvents: [],
    consumesEvents: [],
    initialize: async () => undefined,
    healthCheck: async () => ({ status: 'healthy' }),
    embed: async () => { throw new Error('not impl') },
    complete: vi.fn(async () => responseText),
  }
}

function makeProductService(description = ''): ProductService {
  const snapshot = {
    id: 'prod-1', slug: 'test-product', name: 'Test Product',
    description, shortDescription: '', status: 'active' as const,
    type: 'simple' as const, seoTitle: '', seoDescription: '',
    media: [], metadata: {}, categoryIds: [], variants: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }
  return {
    getById: vi.fn(async () => snapshot),
    update: vi.fn(async () => snapshot),
    create: vi.fn(),
    delete: vi.fn(),
    publish: vi.fn(),
    unpublish: vi.fn(),
    getBySlug: vi.fn(),
    list: vi.fn(),
  } as unknown as ProductService
}

const VALID_AI_RESPONSE = JSON.stringify({
  description: 'A wonderful product description with all the details.',
  shortDescription: 'Quick summary.',
  seoTitle: 'Test Product — Best Quality',
  seoDescription: 'Buy the best Test Product. Great value and quality.',
})

describe('enrichProduct', () => {
  it('calls AI adapter complete() with product info', async () => {
    const ai = makeAiAdapter(VALID_AI_RESPONSE)
    const svc = makeProductService()
    await enrichProduct('prod-1', 'Test Product', '', ai, svc)
    expect(ai.complete).toHaveBeenCalledOnce()
    const prompt = vi.mocked(ai.complete).mock.calls[0]?.[0] ?? ''
    expect(prompt).toContain('Test Product')
  })

  it('updates product with enriched copy', async () => {
    const ai = makeAiAdapter(VALID_AI_RESPONSE)
    const svc = makeProductService()
    const result = await enrichProduct('prod-1', 'Test Product', '', ai, svc)
    expect(result).toBe(true)
    expect(svc.update).toHaveBeenCalledWith(
      'prod-1',
      expect.objectContaining({
        description: 'A wonderful product description with all the details.',
        seoTitle: 'Test Product — Best Quality',
      }),
    )
  })

  it('stores original description in metadata', async () => {
    const ai = makeAiAdapter(VALID_AI_RESPONSE)
    const svc = makeProductService('original text')
    await enrichProduct('prod-1', 'Test Product', 'original text', ai, svc)
    const updateCall = vi.mocked(svc.update).mock.calls[0]?.[1]
    const original = updateCall?.metadata?.['original'] as Record<string, string>
    expect(original?.['description']).toBe('original text')
  })

  it('returns false when AI throws', async () => {
    const ai: AiAdapter = { ...makeAiAdapter(''), complete: vi.fn(async () => { throw new Error('API error') }) }
    const svc = makeProductService()
    const result = await enrichProduct('prod-1', 'Test', '', ai, svc)
    expect(result).toBe(false)
    expect(svc.update).not.toHaveBeenCalled()
  })

  it('returns false when AI returns unparseable JSON', async () => {
    const ai = makeAiAdapter('Sorry, I cannot help with that.')
    const svc = makeProductService()
    const result = await enrichProduct('prod-1', 'Test', '', ai, svc)
    expect(result).toBe(false)
  })
})

describe('runEnrichment', () => {
  it('skips products with sufficient content', async () => {
    const longDesc = Array.from({ length: 60 }, () => 'word').join(' ')
    const ai = makeAiAdapter(VALID_AI_RESPONSE)
    const svc = makeProductService(longDesc)

    const stats = await runEnrichment(['prod-1'], ai, svc, () => undefined)
    expect(stats.skipped).toBe(1)
    expect(stats.enriched).toBe(0)
    expect(ai.complete).not.toHaveBeenCalled()
  })

  it('enriches products with thin content', async () => {
    const ai = makeAiAdapter(VALID_AI_RESPONSE)
    const svc = makeProductService('Too short.')

    const stats = await runEnrichment(['prod-1'], ai, svc, () => undefined)
    expect(stats.enriched).toBe(1)
    expect(stats.skipped).toBe(0)
  })

  it('calls onProgress for each product', async () => {
    const ai = makeAiAdapter(VALID_AI_RESPONSE)
    const svc = makeProductService('')
    const progress: Array<[number, number]> = []

    await runEnrichment(['p1', 'p2', 'p3'], ai, svc, (done, total) => progress.push([done, total]))
    expect(progress).toEqual([[1, 3], [2, 3], [3, 3]])
  })

  it('counts failures gracefully', async () => {
    const ai: AiAdapter = { ...makeAiAdapter(''), complete: vi.fn(async () => { throw new Error('fail') }) }
    const svc = makeProductService('thin')

    const stats = await runEnrichment(['prod-1'], ai, svc, () => undefined)
    expect(stats.failed).toBe(1)
    expect(stats.enriched).toBe(0)
  })
})
