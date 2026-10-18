import { z, type ZodTypeAny } from 'zod'

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
}

const id = z.string().min(1)
/** A query value as the HTTP layer hands it over: repeated keys arrive as an array. */
const queryValue = z.union([z.string(), z.array(z.string())]).optional()
const paging = { limit: queryValue, offset: queryValue }

const idParams = z.object({ id })
const orderIdParams = idParams
const variantIdParams = z.object({ variantId: id })
const orderNumberParams = z.object({ orderNumber: id })

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

const orderLineItem = z.object({
  variantId: z.string(),
  productId: z.string(),
  productName: z.string(),
  variantName: z.string(),
  sku: z.string(),
  qty: z.number().int(),
  unitPriceMinor: money,
  lineSubtotalMinor: money,
  lineTaxMinor: money,
  lineTotalMinor: money,
  imageUrl: z.string(),
})

const noteBody = z.object({ body: z.string().min(1) })
/** A refresh token in the body, or none: the cookie carries it for a browser. */
const optionalRefresh = z.object({ refreshToken: z.string().optional() }).optional()

export const routeSchemas: Record<string, RouteSchema> = {
  // Auth
  'POST /api/auth/register': {
    name: 'auth.register',
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
    description: 'Sign a customer in with email and password.',
    body: z.object({ email: z.string().min(1), password: z.string().min(1) }),
  },
  'POST /api/auth/refresh': {
    name: 'auth.refresh',
    description: 'Exchange a refresh token for a new access token.',
    body: optionalRefresh,
  },
  'POST /api/auth/logout': {
    name: 'auth.logout',
    description: 'Revoke the refresh token and clear its cookie.',
    body: optionalRefresh,
  },

  // Catalogue
  'GET /api/categories': {
    name: 'categories.list',
    description: 'List the store categories in display order.',
  },
  'GET /api/products/search': {
    name: 'products.search',
    description: 'Search products by text.',
    query: z.object({ q: queryValue, limit: queryValue, cursor: queryValue }),
  },
  'GET /api/products': {
    name: 'products.list',
    description: 'List products, optionally in one category.',
    query: z.object({ limit: queryValue, cursor: queryValue, category: queryValue }),
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

  // Cart
  'GET /api/cart': {
    name: 'cart.get',
    description: 'Get the current cart, creating one when there is none.',
  },
  'POST /api/cart/items': {
    name: 'cart.addItem',
    description: 'Add a quantity of a variant to the cart.',
    body: z.object({ variantId: id, qty: z.number().int().positive().optional() }),
  },
  'PATCH /api/cart/items/:variantId': {
    name: 'cart.updateItem',
    description: 'Set the quantity of a variant in the cart.',
    params: variantIdParams,
    body: z.object({ qty: z.number().int().nonnegative() }),
  },
  'DELETE /api/cart/items/:variantId': {
    name: 'cart.removeItem',
    description: 'Remove a variant from the cart.',
    params: variantIdParams,
  },
  'DELETE /api/cart': {
    name: 'cart.clear',
    description: 'Remove every item from the cart.',
  },

  // Checkout and orders
  'POST /api/checkout': {
    name: 'checkout.begin',
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
    description: 'Get one order by its number.',
    params: orderNumberParams,
  },

  // Customer account
  'GET /api/customers/me': {
    name: 'customers.me',
    description: "Get the signed-in customer's profile.",
  },
  'PATCH /api/customers/me': {
    name: 'customers.updateMe',
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
    description: 'Save an address for the signed-in customer.',
    body: address.extend({
      isDefaultBilling: z.boolean().optional(),
      isDefaultShipping: z.boolean().optional(),
    }),
  },
  'DELETE /api/customers/me/addresses/:id': {
    name: 'customers.removeAddress',
    description: "Delete one of the signed-in customer's saved addresses.",
    params: idParams,
  },

  // Admin: session and overview
  'GET /api/admin/me': {
    name: 'admin.me',
    description: 'Get the signed-in admin and the store it administers.',
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
    description: 'Get one order with its status history.',
    params: orderNumberParams,
  },
  'POST /api/admin/orders/:id/confirm': {
    name: 'admin.orders.confirm',
    description: 'Move an order to confirmed.',
    params: orderIdParams,
  },
  'POST /api/admin/orders/:id/process': {
    name: 'admin.orders.process',
    description: 'Move a confirmed order to processing.',
    params: orderIdParams,
  },
  'POST /api/admin/orders/:id/cancel': {
    name: 'admin.orders.cancel',
    description: 'Cancel an order, with an optional reason.',
    params: orderIdParams,
    body: z.object({ reason: z.string().optional() }).optional(),
  },
  'POST /api/admin/orders/:id/mark-paid': {
    name: 'admin.orders.markPaid',
    description: 'Record a payment taken outside the store.',
    params: orderIdParams,
    body: z.object({
      paymentIntentId: z.string().min(1),
      amountMinor: money,
      currency: z.string().min(1),
    }),
  },
  'POST /api/admin/orders/:id/mark-delivered': {
    name: 'admin.orders.markDelivered',
    description: 'Move a shipped order to delivered.',
    params: orderIdParams,
  },
  'POST /api/admin/orders/:id/ship': {
    name: 'admin.orders.ship',
    description: 'Mark an order shipped with its tracking number and carrier.',
    params: orderIdParams,
    body: z.object({ trackingNumber: z.string().min(1), carrier: z.string().min(1) }),
  },
  'POST /api/admin/orders/:id/refund': {
    name: 'admin.orders.refund',
    description: 'Refund an order in full.',
    params: orderIdParams,
    body: z.object({ amountMinor: money.positive(), reason: z.string().optional() }),
  },
  'POST /api/admin/orders/:id/partial-refund': {
    name: 'admin.orders.partialRefund',
    description: 'Refund part of an order, optionally naming its lines.',
    params: orderIdParams,
    body: z.object({
      amountMinor: money,
      reason: z.string().optional(),
      lineItems: z.array(orderLineItem).optional(),
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
    description: 'Add an internal note to an order.',
    params: orderIdParams,
    body: noteBody,
  },
  'POST /api/admin/orders/:id/resend-confirmation': {
    name: 'admin.orders.resendConfirmation',
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
    description: 'Create a product with its variants.',
    body: z.object({
      slug: z.string().min(1),
      name: z.string().min(1),
      ...productFields,
      variants: z.array(productVariant).optional(),
    }),
  },
  'PATCH /api/admin/products/:id': {
    name: 'admin.products.update',
    description: "Update a product's fields.",
    params: idParams,
    body: z.object({ name: z.string().optional(), ...productFields }),
  },
  'DELETE /api/admin/products/:id': {
    name: 'admin.products.delete',
    description: 'Delete a product.',
    params: idParams,
  },
  'POST /api/admin/products/:id/publish': {
    name: 'admin.products.publish',
    description: 'Make a product visible in the store.',
    params: idParams,
  },
  'POST /api/admin/products/:id/unpublish': {
    name: 'admin.products.unpublish',
    description: 'Hide a product from the store.',
    params: idParams,
  },
  'POST /api/admin/products/:id/archive': {
    name: 'admin.products.archive',
    description: 'Archive a product.',
    params: idParams,
  },
  'POST /api/admin/products/:id/duplicate': {
    name: 'admin.products.duplicate',
    description: 'Copy a product as a draft.',
    params: idParams,
  },
  'POST /api/admin/products/:id/enhance': {
    name: 'admin.products.enhance',
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
    description: 'List customers who have ordered, filtered and sorted.',
    query: z.object({ q: queryValue, sort: queryValue, ...paging }),
  },
  'GET /api/admin/customers/:id': {
    name: 'admin.customers.get',
    description: 'Get one customer with order statistics.',
    params: idParams,
  },
  'GET /api/admin/customers/:id/orders': {
    name: 'admin.customers.orders',
    description: "List one customer's orders.",
    params: idParams,
  },
  'POST /api/admin/customers/:id/notes': {
    name: 'admin.customers.addNote',
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
    description: 'Approve or reject a review.',
    params: idParams,
    body: z.object({ status: z.enum(['approved', 'rejected']) }),
  },

  // Admin: live events
  'POST /api/admin/events/ticket': {
    name: 'admin.events.ticket',
    description: 'Issue a one-time ticket for the admin event stream.',
  },
  'GET /api/admin/events': {
    name: 'admin.events.stream',
    description: 'Stream order, payment and inventory events to the admin (SSE).',
    query: z.object({ ticket: queryValue }),
  },

  // Webhooks
  'POST /api/webhooks/stripe': {
    name: 'webhooks.stripe',
    description: 'Receive a signed Stripe event.',
    // The signature covers the raw bytes, and a malformed event is answered by the handler itself.
    body: z.unknown(),
  },

  // The admin SPA, served in production only
  'GET /admin': {
    name: 'admin.app.redirect',
    description: 'Redirect to the admin app.',
  },
  'GET /admin/*': {
    name: 'admin.app.asset',
    description: 'Serve the admin app and its assets.',
    params: z.object({ '*': z.string().optional() }),
  },
}
