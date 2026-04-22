export * as sqliteSchema from './sqlite.js'
export * as postgresSchema from './postgres.js'

export interface ProductRow {
  id: string
  slug: string
  title: string
  description: string
  priceMinor: number
  currency: string
  categoryId: string
  imageUrl: string
  createdAt: Date | string
  updatedAt: Date | string
}

export interface CategoryRow {
  id: string
  slug: string
  name: string
  description: string
  createdAt: Date | string
}
