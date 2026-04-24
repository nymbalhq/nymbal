import type { CategoryCreateInput } from '@nymbal/platform'
import type { WcCategory } from '../client.js'

export function mapCategory(
  wc: WcCategory,
  nymbalParentId: string | undefined,
): CategoryCreateInput {
  const result: CategoryCreateInput = {
    slug: slugify(wc.slug || wc.name),
    name: wc.name,
    parentId: nymbalParentId ?? null,
    position: 0,
  }
  if (wc.description) result.description = wc.description
  return result
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}
