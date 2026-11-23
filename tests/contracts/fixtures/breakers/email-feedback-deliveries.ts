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

/**
 * The shared options with a policy rejection sample: the test provider hands on the classification it is sent, so a
 * sample signed `soft` is a provider that reads the refusal right, and one signed `hard` a provider that does not.
 */
export const withPolicyRejection = (bounce: 'soft' | 'hard') => ({
  ...emailFeedbackOptions,
  policyRejection: () => ({
    request: formDelivery(
      `dlv_breakers_policy_${bounce}`,
      bounce === 'soft'
        ? softBounce('policy@breakers.test', AT)
        : hardBounce('policy@breakers.test', AT),
    ),
    recipient: 'policy@breakers.test',
  }),
})
