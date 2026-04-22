import type {
  AnalyticsAdapter,
  AiAdapter,
  DocumentStoreAdapter,
  EmailAdapter,
  Logger,
  PaymentsAdapter,
  ReviewsAdapter,
  SearchAdapter,
  SecurityAdapter,
  ShippingAdapter,
  TaxAdapter,
} from '@nymbal/types'
import type { NymbalConfig } from '@nymbal/config'
import type { Repositories } from '../repositories/index.js'
import { createMiddlewareSecurityAdapter } from './security/middleware-adapter.js'
import {
  createStripePaymentsAdapter,
  type StripePaymentsConfig,
} from './payments/stripe-adapter.js'
import { createNativeStubPaymentsAdapter } from './payments/native-stub.js'
import {
  createNativeEmailAdapter,
  type NativeEmailAdapterConfig,
} from './email/native-email-adapter.js'
import { createNativeSearchAdapter } from './search/native-adapter.js'
import { createNativeReviewsAdapter } from './reviews/native-adapter.js'
import { createNativeAnalyticsAdapter } from './analytics/native-adapter.js'
import { createNativeShippingAdapter } from './shipping/native-adapter.js'
import { createNativeTaxAdapter } from './tax/native-adapter.js'
import { createNativeAiAdapter } from './ai/native-adapter.js'

export interface AdapterRegistry {
  security: SecurityAdapter
  payments: PaymentsAdapter
  email: EmailAdapter
  search: SearchAdapter
  reviews: ReviewsAdapter
  analytics: AnalyticsAdapter
  shipping: ShippingAdapter
  tax: TaxAdapter
  ai: AiAdapter
}

export interface BuildAdaptersDeps {
  config: NymbalConfig
  logger: Logger
  documentStore: DocumentStoreAdapter
  repos: Repositories
}

export async function buildAdapters(deps: BuildAdaptersDeps): Promise<AdapterRegistry> {
  const { config, logger, documentStore, repos } = deps
  const paymentsProvider = config.commerce.payments.provider
  const payments: PaymentsAdapter =
    paymentsProvider === 'stripe'
      ? createStripePaymentsAdapter({
          logger: logger.child({ adapter: 'payments' }),
          config: (config.commerce.payments.config ?? {}) as unknown as StripePaymentsConfig,
        })
      : createNativeStubPaymentsAdapter({ logger: logger.child({ adapter: 'payments' }) })

  const email: EmailAdapter = createNativeEmailAdapter({
    logger: logger.child({ adapter: 'email' }),
    config: (config.commerce.email.config ?? {}) as NativeEmailAdapterConfig,
  })
  await email.initialize(email ? config.commerce.email.config ?? {} : {})

  const search = createNativeSearchAdapter({
    documentStore,
    logger: logger.child({ adapter: 'search' }),
  })

  const reviews = createNativeReviewsAdapter({
    repos,
    logger: logger.child({ adapter: 'reviews' }),
  })

  const analytics = createNativeAnalyticsAdapter(logger)
  const shipping = createNativeShippingAdapter(logger)
  const tax = createNativeTaxAdapter(logger)
  const ai = createNativeAiAdapter(logger)
  const security = createMiddlewareSecurityAdapter({
    logger: logger.child({ adapter: 'security' }),
  })

  return { security, payments, email, search, reviews, analytics, shipping, tax, ai }
}
