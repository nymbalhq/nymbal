import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
  uniqueIndex,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core'

// --- Categories ------------------------------------------------------------

export const categories = pgTable(
  'categories',
  {
    id: text('id').primaryKey(),
    parentId: text('parent_id'),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    slugUnique: uniqueIndex('categories_slug_unique').on(t.slug),
    parentIdx: index('categories_parent_idx').on(t.parentId),
  }),
)

// --- Products --------------------------------------------------------------

export const products = pgTable(
  'products',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    shortDescription: text('short_description').notNull().default(''),
    status: text('status', { enum: ['draft', 'active', 'archived'] })
      .notNull()
      .default('draft'),
    type: text('type', { enum: ['simple', 'variable'] }).notNull().default('simple'),
    seoTitle: text('seo_title').notNull().default(''),
    seoDescription: text('seo_description').notNull().default(''),
    media: jsonb('media').notNull().default([]),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    slugUnique: uniqueIndex('products_slug_unique').on(t.slug),
    statusIdx: index('products_status_idx').on(t.status),
  }),
)

// --- Variants --------------------------------------------------------------

export const variants = pgTable(
  'variants',
  {
    id: text('id').primaryKey(),
    productId: text('product_id').notNull(),
    sku: text('sku').notNull(),
    name: text('name').notNull().default(''),
    priceMinor: integer('price_minor').notNull(),
    compareAtPriceMinor: integer('compare_at_price_minor'),
    weightGrams: integer('weight_grams'),
    dimensions: jsonb('dimensions'),
    stock: integer('stock').notNull().default(0),
    lowStockThreshold: integer('low_stock_threshold').notNull().default(0),
    options: jsonb('options').notNull().default([]),
    status: text('status', { enum: ['active', 'inactive'] })
      .notNull()
      .default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    skuUnique: uniqueIndex('variants_sku_unique').on(t.sku),
    productIdx: index('variants_product_idx').on(t.productId),
  }),
)

// --- Product ↔ Category join ----------------------------------------------

export const productCategories = pgTable(
  'product_categories',
  {
    productId: text('product_id').notNull(),
    categoryId: text('category_id').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.productId, t.categoryId] }),
    categoryIdx: index('product_categories_category_idx').on(t.categoryId),
  }),
)

// --- Customers -------------------------------------------------------------

export const customers = pgTable(
  'customers',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    firstName: text('first_name').notNull().default(''),
    lastName: text('last_name').notNull().default(''),
    phone: text('phone').notNull().default(''),
    addresses: jsonb('addresses').notNull().default([]),
    orderCount: integer('order_count').notNull().default(0),
    totalSpentMinor: integer('total_spent_minor').notNull().default(0),
    metadata: jsonb('metadata').notNull().default({}),
    requiresPasswordReset: boolean('requires_password_reset').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    emailUnique: uniqueIndex('customers_email_unique').on(t.email),
  }),
)

// --- Refresh tokens --------------------------------------------------------

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: text('id').primaryKey(),
    customerId: text('customer_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedByJti: text('replaced_by_jti'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    customerIdx: index('refresh_tokens_customer_idx').on(t.customerId),
  }),
)

// --- Orders ----------------------------------------------------------------

export const orders = pgTable(
  'orders',
  {
    id: text('id').primaryKey(),
    orderNumber: text('order_number').notNull(),
    sequence: integer('sequence').notNull(),
    customerId: text('customer_id'),
    status: text('status', {
      enum: [
        'pending',
        'confirmed',
        'processing',
        'shipped',
        'delivered',
        'cancelled',
        'refunded',
        'partially_refunded',
      ],
    })
      .notNull()
      .default('pending'),
    email: text('email').notNull(),
    billingAddress: jsonb('billing_address').notNull(),
    shippingAddress: jsonb('shipping_address').notNull(),
    lineItems: jsonb('line_items').notNull(),
    subtotalMinor: integer('subtotal_minor').notNull(),
    taxTotalMinor: integer('tax_total_minor').notNull().default(0),
    shippingTotalMinor: integer('shipping_total_minor').notNull().default(0),
    discountTotalMinor: integer('discount_total_minor').notNull().default(0),
    totalMinor: integer('total_minor').notNull(),
    currency: text('currency').notNull(),
    notes: text('notes').notNull().default(''),
    metadata: jsonb('metadata').notNull().default({}),
    paymentIntentId: text('payment_intent_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    numberUnique: uniqueIndex('orders_number_unique').on(t.orderNumber),
    sequenceUnique: uniqueIndex('orders_sequence_unique').on(t.sequence),
    customerIdx: index('orders_customer_idx').on(t.customerId),
    statusIdx: index('orders_status_idx').on(t.status),
  }),
)

export const orderHistory = pgTable(
  'order_history',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actor: text('actor').notNull(),
    note: text('note').notNull().default(''),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
  },
  (t) => ({
    orderIdx: index('order_history_order_idx').on(t.orderId),
  }),
)

export const orderSequences = pgTable('order_sequences', {
  id: integer('id').primaryKey(),
  nextValue: integer('next_value').notNull(),
})

// --- Inventory -------------------------------------------------------------

export const inventoryReservations = pgTable(
  'inventory_reservations',
  {
    reservationId: text('reservation_id').primaryKey(),
    variantId: text('variant_id').notNull(),
    qty: integer('qty').notNull(),
    orderRef: text('order_ref'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    variantIdx: index('inv_reservations_variant_idx').on(t.variantId),
    expiresIdx: index('inv_reservations_expires_idx').on(t.expiresAt),
  }),
)

export const stockAdjustments = pgTable(
  'stock_adjustments',
  {
    id: text('id').primaryKey(),
    variantId: text('variant_id').notNull(),
    adjustment: integer('adjustment').notNull(),
    reason: text('reason', {
      enum: [
        'sale',
        'return',
        'manual',
        'import',
        'reservation-commit',
        'reservation-release',
      ],
    }).notNull(),
    actor: text('actor').notNull(),
    previousQty: integer('previous_qty').notNull(),
    newQty: integer('new_qty').notNull(),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
  },
  (t) => ({
    variantIdx: index('stock_adjustments_variant_idx').on(t.variantId),
  }),
)

// --- Reviews ---------------------------------------------------------------

export const reviews = pgTable(
  'reviews',
  {
    id: text('id').primaryKey(),
    productId: text('product_id').notNull(),
    customerId: text('customer_id'),
    orderId: text('order_id'),
    rating: integer('rating').notNull(),
    title: text('title').notNull().default(''),
    body: text('body').notNull().default(''),
    moderationStatus: text('moderation_status', {
      enum: ['pending', 'approved', 'rejected'],
    })
      .notNull()
      .default('pending'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull(),
    moderatedAt: timestamp('moderated_at', { withTimezone: true }),
    moderatedBy: text('moderated_by'),
  },
  (t) => ({
    productIdx: index('reviews_product_idx').on(t.productId),
    statusIdx: index('reviews_status_idx').on(t.moderationStatus),
  }),
)

export const schema = {
  categories,
  products,
  variants,
  productCategories,
  customers,
  refreshTokens,
  orders,
  orderHistory,
  orderSequences,
  inventoryReservations,
  stockAdjustments,
  reviews,
}
