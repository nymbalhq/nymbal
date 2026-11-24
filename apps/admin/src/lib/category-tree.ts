import type { Category } from '@nymbalhq/types'

export interface TreeRow {
  category: Category
  depth: number
}

/**
 * The categories as a flat tree: each parent followed by its children, siblings in the order given. A category whose
 * parent is not in the list is a root.
 */
export function categoryTree(categories: readonly Category[]): TreeRow[] {
  const ids = new Set(categories.map((c) => c.id))
  const children = new Map<string | null, Category[]>()
  for (const c of categories) {
    const parent = c.parentId !== null && ids.has(c.parentId) ? c.parentId : null
    children.set(parent, [...(children.get(parent) ?? []), c])
  }
  const rows: TreeRow[] = []
  const visit = (parent: string | null, depth: number) => {
    for (const category of children.get(parent) ?? []) {
      rows.push({ category, depth })
      visit(category.id, depth + 1)
    }
  }
  visit(null, 0)
  return rows
}
