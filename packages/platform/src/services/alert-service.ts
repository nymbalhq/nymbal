import { v7 as uuidv7 } from 'uuid'
import {
  EVT_ALERT_CONFIRMED,
  EVT_ALERT_REPEATED,
  EVT_ALERT_REQUESTED,
  EVT_ALERT_SENT,
  EVT_ALERT_UNSUBSCRIBED,
  HttpError,
  type AlertKind,
  type AlertStatus,
  type NymbalEvent,
  type ProductVariantPriceChangedV1Payload,
} from '@nymbalhq/types'
import { audit } from '../audit/audit.js'
import type { CommandStore, Tx } from '../db/command-store.js'
import { normaliseEmail } from '../email-address.js'
import type { EventPublisher } from '../events/publisher.js'
import type { AlertSubscription } from '../repositories/alert-subscription.js'
import type { Repositories } from '../repositories/index.js'
import { newAlertToken } from './alert-token.js'

export interface AlertSubscribeInput {
  email: string
  variantId: string
  kind: AlertKind
  /** The request's `Origin` header: the storefront the links in its emails point at. */
  origin: string | undefined
}

export interface AlertConfirmed {
  status: 'active'
  kind: AlertKind
  product: { name: string; slug: string }
}

export interface AlertService {
  /**
   * Answers `pending` whatever the address's account or subscription, so the answer reveals neither; every accepted
   * request writes the row once. Only a row that is not `active` is (re)sent its confirmation.
   */
  subscribe(input: AlertSubscribeInput): Promise<{ status: 'pending' }>
  confirm(token: string): Promise<AlertConfirmed>
  unsubscribe(token: string): Promise<{ status: 'unsubscribed' }>
  /**
   * In the transaction that marks an alert's send: a back-in-stock row is `fired`, a price-drop row stays `active` with
   * the trigger's price as its baseline; `alert.sent.v1` names the trigger.
   */
  recordSent(tx: Tx, subscription: AlertSubscription, trigger: NymbalEvent<unknown>): Promise<void>
}

export interface CreateAlertServiceDeps {
  store: CommandStore
  repos: Repositories
  publisher: EventPublisher
  /** `http.cors.allowedOrigins`: the storefronts a subscribe may come from. A `*` entry matches no origin. */
  allowedOrigins: readonly string[]
  /** Whether the store's email reaches a mailbox; a store whose email only logs takes no subscription. */
  delivers(): boolean
}

const CONFIRMABLE: readonly AlertStatus[] = ['pending', 'active']
const UNSUBSCRIBABLE: readonly AlertStatus[] = ['pending', 'active', 'fired']

function linkInvalid(): HttpError {
  return new HttpError(404, 'This link is not valid or no longer applies', {
    code: 'alerts.link_invalid',
  })
}

export function createAlertService(deps: CreateAlertServiceDeps): AlertService {
  const { store, repos, publisher } = deps
  const origins = new Set(deps.allowedOrigins.filter((origin) => origin !== '*'))

  return {
    async subscribe({ email, variantId, kind, origin }) {
      return store.transaction(async (tx) => {
        audit.note('alert.subscribe', [{ type: 'variant', id: variantId }])
        if (!deps.delivers()) {
          throw new HttpError(409, 'This store does not send email alerts', {
            code: 'alerts.unavailable',
          })
        }
        if (origin === undefined || !origins.has(origin)) {
          throw new HttpError(
            400,
            'The request does not come from one of the store’s storefronts',
            {
              code: 'alerts.origin_not_allowed',
            },
          )
        }
        const variant = await repos.variant.findById(tx, variantId)
        if (variant === null) {
          throw new HttpError(404, `Variant ${variantId} not found`, {
            code: 'alerts.variant_not_found',
          })
        }
        const row = await repos.alertSubscription.upsertPending(tx, {
          id: uuidv7(),
          email: normaliseEmail(email),
          kind,
          variantId,
          productId: variant.productId,
          confirmToken: newAlertToken(),
          unsubscribeToken: newAlertToken(),
          origin,
          baselinePriceMinor: kind === 'price_drop' ? variant.priceMinor : null,
          at: new Date(),
        })
        // A pending row owes a confirmation; an active one stands as it was, only its updated_at moved.
        await publisher.publish(
          row.status === 'pending' ? EVT_ALERT_REQUESTED : EVT_ALERT_REPEATED,
          {
            subscriptionId: row.id,
            kind,
            variantId,
            productId: variant.productId,
          },
        )
        return { status: 'pending' as const }
      })
    },

    async confirm(token) {
      return store.transaction(async (tx) => {
        audit.note('alert.confirm')
        const row = await repos.alertSubscription.findByConfirmToken(tx, token)
        const product = row === null ? null : await repos.product.findById(tx, row.productId)
        if (row === null || product === null || !CONFIRMABLE.includes(row.status)) {
          throw linkInvalid()
        }
        audit.note('alert.confirm', [{ type: 'alert', id: row.id }])
        if (row.status === 'pending') {
          const now = new Date()
          await repos.alertSubscription.update(
            tx,
            row.id,
            { status: 'active', updatedAt: now, confirmedAt: now },
            ['pending'],
          )
          await publisher.publish(EVT_ALERT_CONFIRMED, { subscriptionId: row.id })
        }
        return {
          status: 'active' as const,
          kind: row.kind,
          product: { name: product.name, slug: product.slug },
        }
      })
    },

    async unsubscribe(token) {
      return store.transaction(async (tx) => {
        audit.note('alert.unsubscribe')
        const row = await repos.alertSubscription.findByUnsubscribeToken(tx, token)
        if (row === null) throw linkInvalid()
        audit.note('alert.unsubscribe', [{ type: 'alert', id: row.id }])
        if (row.status !== 'unsubscribed') {
          await repos.alertSubscription.update(
            tx,
            row.id,
            { status: 'unsubscribed', updatedAt: new Date() },
            UNSUBSCRIBABLE,
          )
          await publisher.publish(EVT_ALERT_UNSUBSCRIBED, { subscriptionId: row.id })
        }
        return { status: 'unsubscribed' as const }
      })
    },

    async recordSent(tx, subscription, trigger) {
      const updatedAt = new Date()
      await repos.alertSubscription.update(
        tx,
        subscription.id,
        subscription.kind === 'price_drop'
          ? {
              status: 'active',
              baselinePriceMinor: (trigger.payload as ProductVariantPriceChangedV1Payload)
                .priceMinor,
              updatedAt,
            }
          : { status: 'fired', updatedAt },
        ['active'],
      )
      await publisher.publish(EVT_ALERT_SENT, {
        subscriptionId: subscription.id,
        kind: subscription.kind,
        triggerEventId: trigger.id,
      })
    },
  }
}
