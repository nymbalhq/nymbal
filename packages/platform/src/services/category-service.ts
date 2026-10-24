import { v7 as uuidv7 } from 'uuid'
import {
  EVT_CATEGORY_CREATED,
  EVT_CATEGORY_UPDATED,
  EVT_CATEGORY_DELETED,
  NotFoundError,
  ValidationError,
  type Category,
  type Logger,
} from '@nymbalhq/types'
import { audit } from '../audit/audit.js'
import type { Repositories } from '../repositories/index.js'
import type { EventPublisher } from '../events/publisher.js'

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
  delete(id: string): Promise<void>
}

export function createCategoryService(deps: {
  repos: Repositories
  publisher: EventPublisher
  logger: Logger
}): CategoryService {
  const { repos, publisher } = deps
  const { store } = repos.category
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
        await repos.category.update(tx, id, input)
        const fresh = (await repos.category.findById(tx, id)) as Category
        await publisher.publish(EVT_CATEGORY_UPDATED, { category: fresh })
        return fresh
      })
    },
    async delete(id) {
      await store.transaction(async (tx) => {
        audit.note('category.delete', [{ type: 'category', id }])
        const existing = await repos.category.findById(tx, id)
        if (!existing) throw new NotFoundError('category', id)
        await repos.category.delete(tx, id)
        await publisher.publish(EVT_CATEGORY_DELETED, {
          categoryId: existing.id,
          slug: existing.slug,
        })
      })
    },
  }
}
