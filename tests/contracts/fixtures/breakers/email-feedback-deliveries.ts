import {
  complaint,
  formDelivery,
  hardBounce,
  softBounce,
  textDelivery,
} from '../../../../packages/platform/tests/support/test-mail'

const AT = new Date('2026-10-29T12:00:00.000Z')

/** A signed hard bounce, soft bounce and complaint, each with its recipient: the options every feedback breaker shares. */
export const emailFeedbackOptions = {
  bounce: () => ({
    request: formDelivery('dlv_breakers_hard', hardBounce('hard@breakers.test', AT)),
    recipient: 'hard@breakers.test',
  }),
  softBounce: () => ({
    request: formDelivery('dlv_breakers_soft', softBounce('soft@breakers.test', AT)),
    recipient: 'soft@breakers.test',
  }),
  complaint: () => ({
    request: textDelivery('dlv_breakers_complaint', complaint('complaint@breakers.test', AT)),
    recipient: 'complaint@breakers.test',
  }),
}
