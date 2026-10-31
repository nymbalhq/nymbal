import {
  emailFeedbackType,
  type EmailAdapter,
  type EmailBouncedV1Payload,
  type EmailComplainedV1Payload,
  type EventBusAdapter,
  type EventHandler,
  type Logger,
  type NymbalEvent,
} from '@nymbalhq/types'
import { normaliseEmail } from '../../email-address.js'
import type { EmailSuppressionReason } from '../../repositories/email-suppression.js'
import type { Repositories } from '../../repositories/index.js'
import { isHooked } from '../../routes/webhooks-inbound.js'

export interface RegisterEmailFeedbackHandlerDeps {
  eventBus: EventBusAdapter
  email: EmailAdapter
  repos: Pick<Repositories, 'emailSuppression'>
  logger: Logger
}

/**
 * Suppresses an address the email adapter reports as hard-bounced or complaining. Only when that adapter takes webhooks
 * itself, by the route's own test: a hookless email adapter's name may be another slot's, whose events must not stop
 * the store's alert mail.
 */
export async function registerEmailFeedbackHandler(
  deps: RegisterEmailFeedbackHandlerDeps,
): Promise<void> {
  const { eventBus, email, repos, logger } = deps
  if (!isHooked(email)) return
  const { store } = repos.emailSuppression

  // Insert-if-absent, so a redelivered event changes nothing and the first reason stays.
  async function suppress(
    event: NymbalEvent<{ recipient: string }>,
    reason: EmailSuppressionReason,
  ): Promise<void> {
    const suppressed = await store.transaction((tx) =>
      repos.emailSuppression.suppress(tx, {
        email: normaliseEmail(event.payload.recipient),
        reason,
        eventId: event.id,
        at: new Date(),
      }),
    )
    logger.info(
      { eventId: event.id, reason, suppressed },
      suppressed ? 'an address was suppressed' : 'the address was already suppressed',
    )
  }

  const onBounced: EventHandler<EmailBouncedV1Payload> = async (event) => {
    if (event.payload.bounce !== 'hard') {
      logger.info({ eventId: event.id }, 'a soft bounce changes nothing')
      return
    }
    await suppress(event, 'hard_bounce')
  }

  const onComplained: EventHandler<EmailComplainedV1Payload> = (event) =>
    suppress(event, 'complaint')

  await eventBus.subscribe(
    emailFeedbackType(email.providerName, 'bounced'),
    onBounced as EventHandler,
    { name: 'email-feedback-bounced' },
  )
  await eventBus.subscribe(
    emailFeedbackType(email.providerName, 'complained'),
    onComplained as EventHandler,
    { name: 'email-feedback-complained' },
  )
}
