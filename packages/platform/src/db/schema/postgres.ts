import { sql } from 'drizzle-orm'
import {
  pgTable,
  bigserial,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
  uniqueIndex,
  index,
  primaryKey,
  check,
  customType,
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
    type: text('type', { enum: ['simple', 'variable'] })
      .notNull()
      .default('simple'),
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
    roles: jsonb('roles').notNull().default(['customer']),
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
    /** The cart the order was placed from; null for imported orders. */
    cartToken: text('cart_token'),
    capturedMinor: integer('captured_minor').notNull().default(0),
    capturedAt: timestamp('captured_at', { withTimezone: true }),
    /** Σ of the succeeded `order_refunds`, written in the transaction that settles each. */
    refundedMinor: integer('refunded_minor').notNull().default(0),
    captureMethod: text('capture_method', { enum: ['provider', 'manual', 'import'] }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    numberUnique: uniqueIndex('orders_number_unique').on(t.orderNumber),
    sequenceUnique: uniqueIndex('orders_sequence_unique').on(t.sequence),
    customerIdx: index('orders_customer_idx').on(t.customerId),
    statusIdx: index('orders_status_idx').on(t.status),
    paymentIntentIdx: index('orders_payment_intent_idx').on(t.paymentIntentId),
    // One pending order per cart, whatever the checkout's lock does.
    pendingCartUnique: uniqueIndex('orders_pending_cart_unique')
      .on(t.cartToken)
      .where(sql`status = 'pending'`),
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

export const orderRefunds = pgTable(
  'order_refunds',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull(),
    providerRefundId: text('provider_refund_id'),
    status: text('status', { enum: ['pending', 'succeeded', 'failed'] })
      .notNull()
      .default('pending'),
    reason: text('reason'),
    actor: text('actor').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    /** The client's key for one refund request: a repeat of it on the order answers the refund it made. */
    requestId: text('request_id'),
  },
  (t) => ({
    orderIdx: index('order_refunds_order_idx').on(t.orderId),
    requestIdx: uniqueIndex('order_refunds_order_request_idx').on(t.orderId, t.requestId),
  }),
)

export const orderSequences = pgTable('order_sequences', {
  id: integer('id').primaryKey(),
  nextValue: integer('next_value').notNull(),
})

// The keys that open an order to a shopper with no session: the sha256 hex of each, never the key.
export const orderAccessKeys = pgTable(
  'order_access_keys',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id').notNull(),
    keyHash: text('key_hash').notNull(),
    purpose: text('purpose', { enum: ['checkout', 'email'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    keyHashIdx: uniqueIndex('order_access_keys_key_hash_idx').on(t.keyHash),
    orderIdx: index('order_access_keys_order_idx').on(t.orderId),
  }),
)

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
      enum: ['sale', 'return', 'manual', 'import', 'reservation-commit', 'reservation-release'],
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

// --- Carts -----------------------------------------------------------------

export const carts = pgTable(
  'carts',
  {
    token: text('token').primaryKey(),
    customerId: text('customer_id'),
    currency: text('currency').notNull(),
    items: jsonb('items').notNull().default([]),
    lineCount: integer('line_count').notNull().default(0),
    subtotalMinor: integer('subtotal_minor').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    /** Set by the abandonment sweeper's claim; every cart write clears it, starting a new inactivity period. */
    abandonedNotifiedAt: timestamp('abandoned_notified_at', { withTimezone: true }),
  },
  (t) => ({
    expiresIdx: index('carts_expires_idx').on(t.expiresAt),
    updatedIdx: index('carts_updated_idx').on(t.updatedAt),
  }),
)

// --- Event log (outbox) and handler idempotency ----------------------------

export const events = pgTable(
  'events',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    id: text('id').notNull(),
    type: text('type').notNull(),
    envelope: jsonb('envelope').notNull(),
    correlationId: text('correlation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    /** Whose event it is (`subjectOf`): what a record's history reads by. */
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    deadAt: timestamp('dead_at', { withTimezone: true }),
  },
  (t) => ({
    idUnique: uniqueIndex('events_id_unique').on(t.id),
    undeliveredIdx: index('events_undelivered_idx').on(t.deliveredAt, t.seq),
    correlationIdx: index('events_correlation_idx').on(t.correlationId, t.seq),
    catchUpIdx: index('events_catch_up_idx').on(t.deadAt, t.deliveredAt, t.seq),
    subjectIdx: index('events_subject_idx').on(t.subjectType, t.subjectId, t.seq),
  }),
)

export const processedEvents = pgTable(
  'processed_events',
  {
    handlerName: text('handler_name').notNull(),
    eventId: text('event_id').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.handlerName, t.eventId] }),
  }),
)

// --- Settings --------------------------------------------------------------

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

/**
 * Values a store owner entered in the admin for the fields a provider package declares: a secret as AES-256-GCM
 * ciphertext with its IV, tag and key id, anything else as `plain`.
 */
export const settings = pgTable(
  'settings',
  {
    slot: text('slot').notNull(),
    path: text('path').notNull(),
    ciphertext: bytea('ciphertext'),
    plain: text('plain'),
    iv: bytea('iv'),
    tag: bytea('tag'),
    keyId: text('key_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    updatedBy: text('updated_by'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.slot, t.path] }),
    oneValue: check(
      'settings_one_value',
      sql`(${t.ciphertext} IS NULL) <> (${t.plain} IS NULL) AND (${t.ciphertext} IS NULL OR (${t.iv} IS NOT NULL AND ${t.tag} IS NOT NULL AND ${t.keyId} IS NOT NULL))`,
    ),
  }),
)

// --- Audit entries ---------------------------------------------------------

/**
 * One row per outermost command, appended in the command's transaction and never updated, deleted or pruned. A key
 * applies once per actor and command: only `applied` rows hold the partial unique index, so `replayed` and `refused`
 * rows may repeat one.
 */
export const auditEntries = pgTable(
  'audit_entries',
  {
    id: text('id').primaryKey(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    actorKind: text('actor_kind').notNull(),
    actorId: text('actor_id').notNull(),
    command: text('command').notNull(),
    subjects: jsonb('subjects').notNull(),
    correlationId: text('correlation_id'),
    idempotencyKey: text('idempotency_key'),
    requestHash: text('request_hash'),
    outcome: text('outcome').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
  },
  (t) => ({
    appliedKeyUnique: uniqueIndex('audit_entries_applied_key_unique')
      .on(t.actorId, t.command, t.idempotencyKey)
      .where(sql`${t.outcome} = 'applied' AND ${t.idempotencyKey} IS NOT NULL`),
    atIdx: index('audit_entries_at_idx').on(t.at, t.id),
    correlationIdx: index('audit_entries_correlation_idx').on(t.correlationId),
    outcomeCheck: check(
      'audit_entries_outcome',
      sql`${t.outcome} IN ('applied', 'refused', 'replayed')`,
    ),
  }),
)

// --- Alert subscriptions ---------------------------------------------------

/**
 * One row per address, variant and kind. The confirm token is reissued on each resubscribe; the unsubscribe token is
 * minted with the row and never changes, so the link in every email ever sent for it keeps working.
 */
export const alertSubscriptions = pgTable(
  'alert_subscriptions',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    kind: text('kind').notNull(),
    variantId: text('variant_id').notNull(),
    productId: text('product_id').notNull(),
    status: text('status').notNull(),
    confirmToken: text('confirm_token').notNull(),
    unsubscribeToken: text('unsubscribe_token').notNull(),
    origin: text('origin').notNull(),
    baselinePriceMinor: integer('baseline_price_minor'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  },
  (t) => ({
    addressUnique: uniqueIndex('alert_subscriptions_address_unique').on(
      t.email,
      t.variantId,
      t.kind,
    ),
    confirmTokenUnique: uniqueIndex('alert_subscriptions_confirm_token_unique').on(t.confirmToken),
    unsubscribeTokenUnique: uniqueIndex('alert_subscriptions_unsubscribe_token_unique').on(
      t.unsubscribeToken,
    ),
    fanOutIdx: index('alert_subscriptions_fan_out_idx').on(t.variantId, t.kind, t.status),
    kindCheck: check('alert_subscriptions_kind', sql`${t.kind} IN ('back_in_stock', 'price_drop')`),
    statusCheck: check(
      'alert_subscriptions_status',
      sql`${t.status} IN ('pending', 'active', 'fired', 'unsubscribed')`,
    ),
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
  orderAccessKeys,
  inventoryReservations,
  stockAdjustments,
  reviews,
  carts,
  events,
  processedEvents,
  settings,
  auditEntries,
  alertSubscriptions,
}
