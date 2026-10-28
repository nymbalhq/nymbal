import {
  sampleBody,
  signedDelivery,
  tampered,
} from '../../../../packages/platform/tests/support/test-hooks'

/** One signed delivery of two events, and the same delivery with one byte changed: the options every webhook breaker shares. */
export const webhookOptions = {
  delivery: () => signedDelivery(sampleBody('dlv_breakers', 2)),
  tampered: () => tampered(signedDelivery(sampleBody('dlv_breakers', 2))),
}
