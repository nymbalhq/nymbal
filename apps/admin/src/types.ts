// Admin-only view shapes. Every shape the admin shares with the kernel is imported from @nymbalhq/types.
import type {
  Customer,
  Order,
  OrderHistoryEntry,
  StockStatus,
  VariantOption,
} from '@nymbalhq/types'

export interface OrderWithHistory extends Order {
  history: OrderHistoryEntry[]
}

export interface CustomerStats {
  orderCount: number
  lifetimeRevenueMinor: number
  avgOrderValueMinor: number
  firstOrderAt: string | null
  lastOrderAt: string | null
}

export interface InventoryRow {
  variantId: string
  productId: string
  productName: string
  sku: string
  options: VariantOption[]
  stock: number
  threshold: number
  status: StockStatus
  updatedAt: string
}

export interface NoteEntry {
  body: string
  actor: string
  at: string
}

export interface AdminMe {
  userId: string
  roles: string[]
  storeName: string
  environment: string
}

export interface DashboardStats {
  today: {
    orderCount: number
    revenueMinor: number
    itemsShipped: number
  }
  recentOrders: Order[]
  lowStock: InventoryRow[]
}

export interface Notification {
  id: string
  type: 'info' | 'warning' | 'error'
  title: string
  message: string
  at: string
  read: boolean
}

// API response shapes — matches POST /api/auth/login envelope
// (refresh token travels via httpOnly cookie, not the body)
export interface LoginResponse {
  data: {
    customer: Customer
    accessToken: string
    expiresIn: number
  }
}
