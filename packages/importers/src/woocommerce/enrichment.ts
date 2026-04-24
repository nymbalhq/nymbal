import type { AiAdapter } from '@nymbal/types'
import type { ProductService } from '@nymbal/platform'
import { isThinContent } from './mappers/product.js'

export interface EnrichmentStats {
  enriched: number
  skipped: number
  failed: number
}

const SYSTEM_PROMPT = `You are an expert e-commerce copywriter. Given a product name and any existing description, write compelling, accurate product copy. Return ONLY a JSON object with these exact fields:
{
  "description": "2-3 paragraph description (plain text, no HTML)",
  "shortDescription": "1-2 sentence summary",
  "seoTitle": "SEO-optimised title (50-60 chars)",
  "seoDescription": "Meta description (140-160 chars)"
}
Do not add information you cannot infer. Be honest about the product.`

export async function enrichProduct(
  productId: string,
  productName: string,
  existingDescription: string,
  aiAdapter: AiAdapter,
  productService: ProductService,
): Promise<boolean> {
  const prompt = `Product name: ${productName}
Existing description: ${existingDescription || '(none)'}

Generate copy for this product.`

  let raw: string
  try {
    raw = await aiAdapter.complete(`${SYSTEM_PROMPT}\n\n${prompt}`, { maxTokens: 800 })
  } catch {
    return false
  }

  let parsed: Record<string, string>
  try {
    const match = /\{[\s\S]*\}/.exec(raw)
    if (!match?.[0]) return false
    parsed = JSON.parse(match[0]) as Record<string, string>
  } catch {
    return false
  }

  await productService.update(productId, {
    description: parsed['description'] ?? existingDescription,
    shortDescription: parsed['shortDescription'] ?? '',
    seoTitle: parsed['seoTitle'] ?? productName,
    seoDescription: parsed['seoDescription'] ?? '',
    metadata: {
      woocommerce: { enriched: true, enrichedAt: new Date().toISOString() },
      original: { description: existingDescription },
    },
  })
  return true
}

export async function runEnrichment(
  productIds: string[],
  aiAdapter: AiAdapter,
  productService: ProductService,
  onProgress: (done: number, total: number) => void,
): Promise<EnrichmentStats> {
  const stats: EnrichmentStats = { enriched: 0, skipped: 0, failed: 0 }
  let done = 0

  for (const id of productIds) {
    try {
      const snapshot = await productService.getById(id)
      const description = snapshot.description ?? ''

      if (!isThinContent(description)) {
        stats.skipped++
      } else {
        const ok = await enrichProduct(id, snapshot.name, description, aiAdapter, productService)
        if (ok) stats.enriched++
        else stats.failed++
      }
    } catch {
      stats.failed++
    }
    done++
    onProgress(done, productIds.length)
  }

  return stats
}
