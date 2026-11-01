import { z, type ZodTypeAny } from 'zod'
import { CART_LINE_MAX_QTY, PRODUCT_SORT_KEYS } from '@nymbalhq/types'

/**
 * The input of one route: what `registerAllRoutes` parses before the handler runs, and what a tool definition is
 * generated from. Unknown keys are stripped, so a handler sees only what is declared here.
 */
export interface RouteSchema {
  /** Unique, dotted: `cart.addItem`. */
  name: string
  description: string
  params?: ZodTypeAny
  query?: ZodTypeAny
  body?: ZodTypeAny
  /**
   * Every route but a GET says what its audit entry names it: the command it runs when it changes the store's records,
   * or null when it changes none an audit covers (a cart, a session, a ticket).
   */
  command?: string | null
  /**
   * The command moves money through the payments provider. A keyed one does not run inside the key's transaction:
   * the service commits its own steps around the provider call, so what it holds is committed before money moves.
   */
  provider?: true
}

const id = z.string().min(1)
/** A query value as the HTTP layer hands it over: repeated keys arrive as an array. */
const queryValue = z.union([z.string(), z.array(z.string())]).optional()
const paging = { limit: queryValue, offset: queryValue }
/** A detail read as the event log folds it at `at`. */
const asOfQuery = z.object({ at: queryValue })
const historyQuery = z.object({ cursor: queryValue, limit: queryValue })

const idParams = z.object({ id })
const orderIdParams = idParams
const variantIdParams = z.object({ variantId: id })
const orderNumberParams = z.object({ orderNumber: id })
const settingParams = z.object({ slot: id, path: id })

const address = z.object({
  firstName: z.string(),
  lastName: z.string(),
  company: z.string().optional(),
  addressLine1: z.string().min(1),
  addressLine2: z.string().optional(),
  city: z.string(),
  region: z.string(),
  postalCode: z.string(),
  country: z.string(),
  phone: z.string().optional(),
})

const money = z.number().int()
const productStatus = z.enum(['draft', 'active', 'archived'])
const productMedia = z.object({ url: z.string(), altText: z.string(), position: z.number() })
const variantDimensions = z.object({
  lengthMm: z.number().optional(),
  widthMm: z.number().optional(),
  heightMm: z.number().optional(),
})
const productVariant = z.object({
  id: z.string().optional(),
  sku: z.string(),
  name: z.string(),
  priceMinor: money,
  compareAtPriceMinor: money.nullable().optional(),
  weightGrams: z.number().nullable().optional(),
  dimensions: variantDimensions.nullable().optional(),
  stock: z.number().int(),
  lowStockThreshold: z.number().int().optional(),
  options: z.array(z.object({ name: z.string(), value: z.string() })),
  status: z.enum(['active', 'inactive']).optional(),
})
/** A variant's prices in a product update: an omitted compare-at price keeps the stored one, null clears it. */
const variantPrices = z.object({
  id,
  priceMinor: money.min(0),
  compareAtPriceMinor: money.min(0).nullable().optional(),
})
const productFields = {
  description: z.string().optional(),
  shortDescription: z.string().optional(),
  status: productStatus.optional(),
  type: z.enum(['simple', 'variable']).optional(),
  seoTitle: z.string().optional(),
  seoDescription: z.string().optional(),
  media: z.array(productMedia).optional(),
  metadata: z.record(z.unknown()).optional(),
  categoryIds: z.array(z.string()).optional(),
}

const noteBody = z.object({ body: z.string().min(1) })
/** A refresh token in the body, or none: the cookie carries it for a browser. */
const optionalRefresh = z.object({ refreshToken: z.string().optional() }).optional()

export const routeSchemas: Record<string, RouteSchema> = {
  // Auth
  'POST /api/auth/register': {
    name: 'auth.register',
    command: 'customer.register',
    description: 'Create a customer account and sign it in.',
    body: z.object({
      email: z.string().min(1),
      password: z.string().min(1),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      phone: z.string().optional(),
    }),
  },
  'POST /api/auth/login': {
    name: 'auth.login',
    command: null,
    description: 'Sign a customer in with email and password.',
    body: z.object({ email: z.string().min(1), password: z.string().min(1) }),
  },
  'POST /api/auth/refresh': {
    name: 'auth.refresh',
    command: null,
    description: 'Exchange a refresh token for a new access token.',
    body: optionalRefresh,
  },
  'POST /api/auth/logout': {
    name: 'auth.logout',
    command: null,
    description: 'Revoke the refresh token and clear its cookie.',
    body: optionalRefresh,
  },

  // Store
  'GET /api/capabilities': {
    name: 'capabilities.get',
    description:
      'What the store can do, for a storefront: payments client half, search capabilities, sort keys and whether email delivers.',
  },

  // Catalogue
  'GET /api/categories': {
    name: 'categories.list',
    description: 'List the store categories in display order.',
  },
  'GET /api/products/search': {
    name: 'products.search',
    description:
      'Search products by text, optionally in one category, in relevance order, with the total and the category facet.',
    query: z.object({ q: queryValue, limit: queryValue, cursor: queryValue, category: queryValue }),
  },
  'GET /api/products': {
    name: 'products.list',
    description:
      'List products, optionally in one category, in one of the sort orders (default newest).',
    query: z.object({
      limit: queryValue,
      cursor: queryValue,
      category: queryValue,
      sort: z.enum(PRODUCT_SORT_KEYS).optional(),
    }),
  },
  'GET /api/products/:slug': {
    name: 'products.get',
    description: 'Get one product by slug.',
    params: z.object({ slug: id }),
  },
  'GET /api/products/:id/reviews': {
    name: 'products.reviews',
    description: 'List the published reviews of a product.',
    params: idParams,
    query: z.object({ limit: queryValue, cursor: queryValue }),
  },

  // Back-in-stock and price-drop alerts
  'POST /api/alerts/subscribe': {
    name: 'alerts.subscribe',
    command: 'alert.subscribe',
    description:
      'Ask to be emailed when a variant is back in stock (`back_in_stock`) or when its price drops (`price_drop`); a confirmation email is sent first.',
    body: z.object({
      email: z.string().trim().max(254).email(),
      variantId: id,
      kind: z.enum(['back_in_stock', 'price_drop']),
    }),
  },
  'POST /api/alerts/confirm': {
    name: 'alerts.confirm',
    command: 'alert.confirm',
    description: 'Confirm an alert subscription with the token from its confirmation email.',
    body: z.object({ token: z.string().min(1) }),
  },
  'POST /api/alerts/unsubscribe': {
    name: 'alerts.unsubscribe',
    command: 'alert.unsubscribe',
    description: 'Stop an alert with the unsubscribe token from any of its emails.',
    body: z.object({ token: z.string().min(1) }),
  },

  // Cart
  'GET /api/cart': {
    name: 'cart.get',
    description: 'Get the current cart, creating one when there is none.',
  },
  'POST /api/cart/items': {
    name: 'cart.addItem',
    command: null,
    description: 'Add a quantity of a variant to the cart.',
    // Strict: an unknown key (`quantity`) is refused rather than stripped, which would add 1.
    body: z
      .object({ variantId: id, qty: z.number().int().min(1).max(CART_LINE_MAX_QTY).optional() })
      .strict(),
  },
  'PATCH /api/cart/items/:variantId': {
    name: 'cart.updateItem',
    command: null,
    description: 'Set the quantity of a variant in the cart.',
    params: variantIdParams,
    body: z.object({ qty: z.number().int().min(0).max(CART_LINE_MAX_QTY) }).strict(),
  },
  'DELETE /api/cart/items/:variantId': {
    name: 'cart.removeItem',
    command: null,
    description: 'Remove a variant from the cart.',
    params: variantIdParams,
  },
  'DELETE /api/cart': {
    name: 'cart.clear',
    command: null,
    description: 'Remove every item from the cart.',
  },

  // Checkout and orders
  'POST /api/checkout': {
    name: 'checkout.begin',
    command: 'checkout.place',
    description: 'Place an order for the cart and start its payment.',
    body: z.object({
      email: z.string().min(1),
      billingAddress: address,
      shippingAddress: address,
      notes: z.string().optional(),
    }),
  },
  'GET /api/orders': {
    name: 'orders.list',
    description: "List the signed-in customer's orders.",
  },
  'GET /api/orders/:orderNumber': {
    name: 'orders.get',
    description:
      "Get one order by its number, with a key that opens it in the x-nymbal-order-key header (an expired key with the order's email in x-nymbal-order-email) or as the order's signed-in customer.",
    params: orderNumberParams,
  },
  'POST /api/orders/link': {
    name: 'orders.requestLink',
    command: 'order.requestLink',
    description:
      "Email the order's link again to the order's own email; the answer is the same whether or not the number and email matched an order.",
    body: z.object({
      orderNumber: z.string().trim().min(1).max(64),
      email: z.string().trim().min(1).max(254),
    }),
  },

  // Recently viewed: the viewer is the bearer's customer or the visitor cookie's, never one the request names.
  'POST /api/recently-viewed': {
    name: 'recentlyViewed.record',
    command: null,
    description: 'Record that the shopper viewed a product.',
    body: z.object({ productId: id }),
  },
  'GET /api/recently-viewed': {
    name: 'recentlyViewed.list',
    description: "List the shopper's recently viewed products, newest first.",
  },

  // Customer account
  'GET /api/customers/me': {
    name: 'customers.me',
    description: "Get the signed-in customer's profile.",
  },
  'PATCH /api/customers/me': {
    name: 'customers.updateMe',
    command: 'customer.update',
    description: "Update the signed-in customer's name or phone.",
    body: z.object({
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      phone: z.string().optional(),
    }),
  },
  'GET /api/customers/me/addresses': {
    name: 'customers.addresses',
    description: "List the signed-in customer's saved addresses.",
  },
  'POST /api/customers/me/addresses': {
    name: 'customers.addAddress',
    command: 'customer.addAddress',
    description: 'Save an address for the signed-in customer.',
    body: address.extend({
      isDefaultBilling: z.boolean().optional(),
      isDefaultShipping: z.boolean().optional(),
    }),
  },
  'DELETE /api/customers/me/addresses/:id': {
    name: 'customers.removeAddress',
    command: 'customer.removeAddress',
    description: "Delete one of the signed-in customer's saved addresses.",
    params: idParams,
  },

  // Admin: session and overview
  'GET /api/admin/me': {
    name: 'admin.me',
    description: 'Get the signed-in admin and the store it administers.',
  },
  'GET /api/admin/settings': {
    name: 'admin.settings.list',
    description:
      "List each slot's provider and the fields it lets Settings fill: where each is set from, and no secret value.",
  },
  'PUT /api/admin/settings/:slot/:path': {
    name: 'admin.settings.put',
    command: 'settings.put',
    description:
      'Save a value for a field the config and environment leave unset; it applies at the next start.',
    params: settingParams,
    body: z.object({ value: z.string().min(1) }),
  },
  'DELETE /api/admin/settings/:slot/:path': {
    name: 'admin.settings.delete',
    command: 'settings.delete',
    description: 'Clear the saved value of a field; it applies at the next start.',
    params: settingParams,
  },
  'GET /api/admin/dashboard': {
    name: 'admin.dashboard',
    description: "Today's order figures, recent orders and low stock.",
  },
  'GET /api/admin/search': {
    name: 'admin.search',
    description: 'Search orders, products and customers.',
    query: z.object({ q: queryValue }),
  },

  // Admin: orders
  'GET /api/admin/orders': {
    name: 'admin.orders.list',
    description: 'List orders, filtered by status, date, customer or text.',
    query: z.object({
      status: queryValue,
      dateFrom: queryValue,
      dateTo: queryValue,
      customer: queryValue,
      q: queryValue,
      ...paging,
    }),
  },
  'GET /api/admin/orders/:orderNumber': {
    name: 'admin.orders.get',
    description:
      'Get one order with its status history; with `at`, the order as the event log folds it at that time.',
    params: orderNumberParams,
    query: asOfQuery,
  },
  'GET /api/admin/orders/:id/history': {
    name: 'admin.orders.history',
    description: "List an order's changes from the event log, newest first.",
    params: orderIdParams,
    query: historyQuery,
  },
  'POST /api/admin/orders/:id/confirm': {
    name: 'admin.orders.confirm',
    command: 'order.confirm',
    description:
      'Move a paid order to confirmed; an unpaid order is refused (record its payment instead).',
    params: orderIdParams,
  },
  'POST /api/admin/orders/:id/process': {
    name: 'admin.orders.process',
    command: 'order.process',
    description: 'Move a confirmed order to processing.',
    params: orderIdParams,
  },
  'POST /api/admin/orders/:id/cancel': {
    name: 'admin.orders.cancel',
    command: 'order.cancel',
    description: 'Cancel an order nothing was captured for, with an optional reason.',
    params: orderIdParams,
    body: z.object({ reason: z.string().optional() }).optional(),
  },
  'POST /api/admin/orders/:id/mark-paid': {
    name: 'admin.orders.markPaid',
    command: 'order.markPaid',
    provider: true,
    description:
      "Record a payment of the order's total taken outside the store, confirming the order.",
    params: orderIdParams,
    body: z.object({ note: z.string().optional() }).optional(),
  },
  'POST /api/admin/orders/:id/mark-delivered': {
    name: 'admin.orders.markDelivered',
    command: 'order.markDelivered',
    description: 'Move a shipped order to delivered.',
    params: orderIdParams,
  },
  'POST /api/admin/orders/:id/ship': {
    name: 'admin.orders.ship',
    command: 'order.ship',
    description: 'Mark an order shipped with its tracking number and carrier.',
    params: orderIdParams,
    body: z.object({ trackingNumber: z.string().min(1), carrier: z.string().min(1) }),
  },
  'POST /api/admin/orders/:id/refund': {
    name: 'admin.orders.refund',
    command: 'order.refund',
    provider: true,
    description:
      'Refund part or all of what an order captured, through the payments provider. A repeated requestId answers the refund it made and moves no money.',
    params: orderIdParams,
    body: z.object({
      amountMinor: money.positive(),
      reason: z.string().optional(),
      requestId: z.string().uuid().optional(),
    }),
  },
  'GET /api/admin/orders/:id/timeline': {
    name: 'admin.orders.timeline',
    description: "List an order's status history.",
    params: orderIdParams,
  },
  'GET /api/admin/orders/:id/notes': {
    name: 'admin.orders.notes',
    description: "List an order's internal notes.",
    params: orderIdParams,
  },
  'POST /api/admin/orders/:id/notes': {
    name: 'admin.orders.addNote',
    command: 'order.addNote',
    description: 'Add an internal note to an order.',
    params: orderIdParams,
    body: noteBody,
  },
  'POST /api/admin/orders/:id/resend-confirmation': {
    name: 'admin.orders.resendConfirmation',
    command: 'order.resendConfirmation',
    description: "Resend an order's confirmation email.",
    params: orderIdParams,
  },

  // Admin: products
  'GET /api/admin/products': {
    name: 'admin.products.list',
    description: 'List products, filtered by status or name.',
    query: z.object({ status: queryValue, q: queryValue, ...paging }),
  },
  'POST /api/admin/products': {
    name: 'admin.products.create',
    command: 'product.create',
    description: 'Create a product with its variants.',
    body: z.object({
      slug: z.string().min(1),
      name: z.string().min(1),
      ...productFields,
      variants: z.array(productVariant).optional(),
    }),
  },
  'GET /api/admin/products/:id': {
    name: 'admin.products.get',
    description:
      'Get one product by id or slug; with `at`, the product as the event log folds it at that time.',
    params: idParams,
    query: asOfQuery,
  },
  'GET /api/admin/products/:id/history': {
    name: 'admin.products.history',
    description: "List a product's changes from the event log, newest first.",
    params: idParams,
    query: historyQuery,
  },
  'PATCH /api/admin/products/:id': {
    name: 'admin.products.update',
    command: 'product.update',
    description:
      "Update a product's fields and its variants' prices; a variant left out keeps its prices, and stock moves only through inventory.",
    params: idParams,
    body: z.object({
      name: z.string().optional(),
      ...productFields,
      variants: z.array(variantPrices).optional(),
    }),
  },
  'DELETE /api/admin/products/:id': {
    name: 'admin.products.delete',
    command: 'product.delete',
    description: 'Delete a product.',
    params: idParams,
  },
  'POST /api/admin/products/:id/publish': {
    name: 'admin.products.publish',
    command: 'product.publish',
    description: 'Make a product visible in the store.',
    params: idParams,
  },
  'POST /api/admin/products/:id/unpublish': {
    name: 'admin.products.unpublish',
    command: 'product.unpublish',
    description: 'Hide a product from the store.',
    params: idParams,
  },
  'POST /api/admin/products/:id/archive': {
    name: 'admin.products.archive',
    command: 'product.archive',
    description: 'Archive a product.',
    params: idParams,
  },
  'POST /api/admin/products/:id/duplicate': {
    name: 'admin.products.duplicate',
    command: 'product.duplicate',
    description: 'Copy a product as a draft.',
    params: idParams,
  },
  'POST /api/admin/products/:id/enhance': {
    name: 'admin.products.enhance',
    command: null,
    description: 'Suggest copy for one product field with the AI adapter.',
    params: idParams,
    body: z.object({
      field: z.enum(['description', 'alt', 'title', 'seoDescription']),
      context: z.record(z.string()).optional(),
    }),
  },

  // Admin: inventory
  'GET /api/admin/inventory': {
    name: 'admin.inventory.list',
    description: 'List variant stock, most urgent first.',
    query: z.object({ status: queryValue, q: queryValue, ...paging }),
  },
  'POST /api/admin/inventory/:variantId/adjust': {
    name: 'admin.inventory.adjust',
    command: 'inventory.adjust',
    description: "Adjust a variant's stock by a delta, with a reason.",
    params: variantIdParams,
    body: z.object({
      delta: z.number().int(),
      reason: z.enum([
        'sale',
        'return',
        'manual',
        'import',
        'reservation-commit',
        'reservation-release',
      ]),
    }),
  },
  'GET /api/admin/inventory/:variantId/history': {
    name: 'admin.inventory.history',
    description: "List a variant's stock adjustments.",
    params: variantIdParams,
  },

  // Admin: customers
  'GET /api/admin/customers': {
    name: 'admin.customers.list',
    description: 'List customers, filtered and sorted.',
    query: z.object({ q: queryValue, sort: queryValue, ...paging }),
  },
  'GET /api/admin/customers/:id': {
    name: 'admin.customers.get',
    description:
      'Get one customer with order statistics; with `at`, the customer as the event log folds it at that time.',
    params: idParams,
    query: asOfQuery,
  },
  'GET /api/admin/customers/:id/history': {
    name: 'admin.customers.history',
    description: "List a customer's changes from the event log, newest first.",
    params: idParams,
    query: historyQuery,
  },
  'GET /api/admin/customers/:id/orders': {
    name: 'admin.customers.orders',
    description: "List one customer's orders.",
    params: idParams,
  },
  'POST /api/admin/customers/:id/notes': {
    name: 'admin.customers.addNote',
    command: 'customer.addNote',
    description: 'Add an internal note to a customer.',
    params: idParams,
    body: noteBody,
  },

  // Admin: reviews
  'GET /api/admin/reviews': {
    name: 'admin.reviews.pending',
    description: 'List reviews awaiting moderation.',
  },
  'POST /api/admin/reviews/:id/moderate': {
    name: 'admin.reviews.moderate',
    command: 'review.moderate',
    description: 'Approve or reject a review.',
    params: idParams,
    body: z.object({ status: z.enum(['approved', 'rejected']) }),
  },

  // Admin: live events
  'POST /api/admin/events/ticket': {
    name: 'admin.events.ticket',
    command: null,
    description: 'Issue a one-time ticket for the admin event stream.',
  },
  'GET /api/admin/events': {
    name: 'admin.events.stream',
    description: 'Stream order, payment and inventory events to the admin (SSE).',
    query: z.object({ ticket: queryValue }),
  },

  // Admin: activity (the audit trail)
  'GET /api/admin/activity': {
    name: 'admin.activity.list',
    description: 'List audit entries newest first, filtered, a page at a time.',
    query: z.object({
      actor: queryValue,
      command: queryValue,
      subject: queryValue,
      correlation: queryValue,
      outcome: queryValue,
      since: queryValue,
      until: queryValue,
      cursor: queryValue,
      limit: queryValue,
    }),
  },
  'GET /api/admin/activity/export': {
    name: 'admin.activity.export',
    description: 'Export audit entries oldest first as NDJSON.',
    query: z.object({ since: queryValue, until: queryValue, correlation: queryValue }),
  },

  // Webhooks
  'POST /api/webhooks/:adapter': {
    name: 'webhooks.receive',
    // The route opens its own audit command: payment.finalize for a payments delivery, webhook.receive otherwise.
    command: null,
    description:
      'Receive a signed delivery from a provider, by its name (stripe always names the payments provider).',
    params: z.object({ adapter: id }),
    // The signature covers the raw bytes, and a malformed event is answered by the handler itself.
    body: z.unknown(),
  },

  // The admin SPA, served when attachHttp is given an admin root (or NYMBAL_ADMIN_DIST is set)
  'GET /admin': {
    name: 'admin.app.redirect',
    description: 'Redirect to the admin app.',
  },
  'GET /admin/': {
    name: 'admin.app.index',
    description: 'Serve the admin app.',
  },
  'GET /admin/*': {
    name: 'admin.app.asset',
    description: 'Serve the admin app and its assets.',
    params: z.object({ '*': z.string().optional() }),
  },
}
