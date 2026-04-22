import { v7 as uuidv7 } from 'uuid'
import {
  EVT_CATEGORY_CREATED,
  EVT_CATEGORY_UPDATED,
  EVT_CATEGORY_DELETED,
  NotFoundError,
  ValidationError,
  type Category,
  type Logger,
} from '@nymbal/types'
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
  return {
    async list() {
      return repos.category.list()
    },
    async getById(id) {
      const c = await repos.category.findById(id)
      if (!c) throw new NotFoundError('category', id)
      return c
    },
    async getBySlug(slug) {
      const c = await repos.category.findBySlug(slug)
      if (!c) throw new NotFoundError('category', slug)
      return c
    },
    async create(input) {
      if (!input.slug.trim()) throw new ValidationError('Category slug is required')
      if (await repos.category.findBySlug(input.slug)) {
        throw new ValidationError(`Category slug already exists: ${input.slug}`)
      }
      const now = new Date()
      const category: Category = {
        id: uuidv7(),
        parentId: input.parentId ?? null,
        slug: input.slug,
        name: input.name,
        description: input.description ?? '',
        position: input.position ?? 0,
        createdAt: now.toISOString(),
      }
      await repos.category.insert({ ...category, createdAt: now })
      await publisher.publish(EVT_CATEGORY_CREATED, { category })
      return category
    },
    async update(id, input) {
      const existing = await repos.category.findById(id)
      if (!existing) throw new NotFoundError('category', id)
      await repos.category.update(id, input)
      const fresh = (await repos.category.findById(id)) as Category
      await publisher.publish(EVT_CATEGORY_UPDATED, { category: fresh })
      return fresh
    },
    async delete(id) {
      const existing = await repos.category.findById(id)
      if (!existing) throw new NotFoundError('category', id)
      await repos.category.delete(id)
      await publisher.publish(EVT_CATEGORY_DELETED, {
        categoryId: existing.id,
        slug: existing.slug,
      })
    },
  }
}
