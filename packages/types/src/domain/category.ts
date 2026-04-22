export interface Category {
  id: string
  parentId: string | null
  name: string
  slug: string
  description: string
  position: number
  createdAt: string
}
