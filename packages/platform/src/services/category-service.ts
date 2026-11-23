import { v7 as uuidv7 } from 'uuid'
import {
  EVT_CATEGORY_CREATED,
  EVT_CATEGORY_UPDATED,
  EVT_CATEGORY_DELETED,
  EVT_PRODUCT_UPDATED,
  NotFoundError,
  ValidationError,
  type Category,
  type Logger,
} from '@nymbalhq/types'
import { audit } from '../audit/audit.js'
import type { Tx } from '../db/command-store.js'
import type { Repositories } from '../repositories/index.js'
import type { EventPublisher } from '../events/publisher.js'
import { productSnapshot } from './product-service.js'

export interface CategoryCreateInput {
  slug: string
  name: string
  description?: string
  parentId?: string | null
  position?: number
}

export interface CategoryUpdateInput {
  name?: string
  description?: string
  parentId?: string | null
  position?: number
}

export interface CategoryService {
  list(): Promise<Category[]>
  getById(id: string): Promise<Category>
  getBySlug(slug: string): Promise<Category>
  create(input: CategoryCreateInput): Promise<Category>
  update(id: string, input: CategoryUpdateInput): Promise<Category>
  /** Detaches the category's products and moves its direct children to its parent, then removes it. */
  delete(id: string): Promise<CategoryDeleted>
  /** Renumbers one parent's children 0..n-1 in the order of `ids`, which must name each of them once. */
  reorder(parentId: string | null, ids: string[]): Promise<Category[]>
}

export interface CategoryDeleted {
  detachedProducts: number
  movedChildren: number
}

/** True when making `parentId` the parent of `id` would make `id` its own ancestor. */
export function wouldCycle(
  categories: readonly Pick<Category, 'id' | 'parentId'>[],
  id: string,
  parentId: string,
): boolean {
  const parentOf = new Map(categories.map((c) => [c.id, c.parentId]))
  let at: string | null | undefined = parentId
  // Bounded by the count, so a cycle already stored cannot loop the walk.
  for (let steps = 0; steps <= categories.length && at != null; steps += 1) {
    if (at === id) return true
    at = parentOf.get(at)
  }
  return false
}

export function createCategoryService(deps: {
  repos: Repositories
  publisher: EventPublisher
  logger: Logger
}): CategoryService {
  const { repos, publisher } = deps
  const { store } = repos.category

  async function requireParent(tx: Tx, parentId: string | null | undefined): Promise<void> {
    if (parentId == null) return
    if (!(await repos.category.findById(tx, parentId))) {
      throw new ValidationError(`Parent category not found: ${parentId}`, {
        code: 'category.parent_unknown',
      })
    }
  }

  return {
    async list() {
      return store.read((tx) => repos.category.list(tx))
    },
    async getById(id) {
      const c = await store.read((tx) => repos.category.findById(tx, id))
      if (!c) throw new NotFoundError('category', id)
      return c
    },
    async getBySlug(slug) {
      const c = await store.read((tx) => repos.category.findBySlug(tx, slug))
      if (!c) throw new NotFoundError('category', slug)
      return c
    },
    async create(input) {
      audit.note('category.create')
      if (!input.slug.trim()) throw new ValidationError('Category slug is required')
      return store.transaction(async (tx) => {
        if (await repos.category.findBySlug(tx, input.slug)) {
          throw new ValidationError(`Category slug already exists: ${input.slug}`)
        }
        await requireParent(tx, input.parentId)
        const now = new Date()
        const id = uuidv7()
        audit.note('category.create', [{ type: 'category', id }])
        const category: Category = {
          id,
          parentId: input.parentId ?? null,
          slug: input.slug,
          name: input.name,
          description: input.description ?? '',
          position: input.position ?? 0,
          createdAt: now.toISOString(),
        }
        await repos.category.insert(tx, { ...category, createdAt: now })
        await publisher.publish(EVT_CATEGORY_CREATED, { category })
        return category
      })
    },
    async update(id, input) {
      return store.transaction(async (tx) => {
        audit.note('category.update', [{ type: 'category', id }])
        const existing = await repos.category.findById(tx, id)
        if (!existing) throw new NotFoundError('category', id)
        if (input.parentId != null) {
          await requireParent(tx, input.parentId)
          if (wouldCycle(await repos.category.list(tx), id, input.parentId)) {
            throw new ValidationError(`A category cannot sit under itself or a descendant: ${id}`, {
              code: 'category.parent_cycle',
            })
          }
        }
        await repos.category.update(tx, id, input)
        const fresh = (await repos.category.findById(tx, id)) as Category
        await publisher.publish(EVT_CATEGORY_UPDATED, { category: fresh })
        return fresh
      })
    },
    async delete(id) {
      return store.transaction(async (tx) => {
        audit.note('category.delete', [{ type: 'category', id }])
        const existing = await repos.category.findById(tx, id)
        if (!existing) throw new NotFoundError('category', id)
        const children = (await repos.category.list(tx)).filter((c) => c.parentId === id)
        for (const child of children) {
          await repos.category.update(tx, child.id, { parentId: existing.parentId })
          await publisher.publish(EVT_CATEGORY_UPDATED, {
            category: { ...child, parentId: existing.parentId },
          })
        }
        // The product projection finds a category's products by the join rows, gone once this commits, so each
        // detached product carries its own event.
        const productIds = await repos.productCategory.listProductsForCategory(tx, id)
        for (const productId of productIds) {
          await repos.productCategory.detach(tx, productId, id)
          const product = await repos.product.findById(tx, productId)
          // A join row left by a product no longer stored is removed with no product to project.
          if (product) {
            await publisher.publish(EVT_PRODUCT_UPDATED, {
              product: await productSnapshot(tx, repos, product),
            })
          }
        }
        await repos.category.delete(tx, id)
        await publisher.publish(EVT_CATEGORY_DELETED, {
          categoryId: existing.id,
          slug: existing.slug,
        })
        return { detachedProducts: productIds.length, movedChildren: children.length }
      })
    },
    async reorder(parentId, ids) {
      return store.transaction(async (tx) => {
        audit.note(
          'category.reorder',
          ids.map((id) => ({ type: 'category', id })),
        )
        const children = (await repos.category.list(tx)).filter((c) => c.parentId === parentId)
        const byId = new Map(children.map((c) => [c.id, c]))
        if (
          ids.length !== children.length ||
          new Set(ids).size !== ids.length ||
          !ids.every((id) => byId.has(id))
        ) {
          throw new ValidationError('ids must name each child of the parent exactly once', {
            code: 'category.reorder_mismatch',
          })
        }
        const ordered: Category[] = []
        for (const [position, id] of ids.entries()) {
          const child = byId.get(id)!
          if (child.position === position) {
            ordered.push(child)
            continue
          }
          await repos.category.update(tx, id, { position })
          const moved = { ...child, position }
          await publisher.publish(EVT_CATEGORY_UPDATED, { category: moved })
          ordered.push(moved)
        }
        return ordered
      })
    },
  }
}
