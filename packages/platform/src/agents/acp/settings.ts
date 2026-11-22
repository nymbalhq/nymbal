import type { NymbalConfig } from '@nymbalhq/config'
import { ConfigError, type PaymentsAdapter } from '@nymbalhq/types'
import { acpKeys, type AcpKey } from './keys.js'

export interface AcpSettings {
  keys: AcpKey[]
  links: NymbalConfig['agents']['acp']['links']
  merchantId?: string | undefined
  /** Whether the payments provider charges for real: the handler tells the agent which tokens to mint. */
  environment: 'test' | 'production'
}

/**
 * Stripe's mode, from its secret key; the stub is always test. Anything this cannot read is reported as production, so
 * an agent never sends a test token to a store that charges for real.
 */
function environmentOf(
  config: NymbalConfig,
  payments: PaymentsAdapter,
  env: NodeJS.ProcessEnv,
): AcpSettings['environment'] {
  if (payments.providerName === 'native-stub') return 'test'
  const configured = (config.commerce.payments.config as { secretKey?: unknown } | undefined)
    ?.secretKey
  const secretKey = typeof configured === 'string' ? configured : env['STRIPE_SECRET_KEY']
  return secretKey?.startsWith('sk_test_') === true ? 'test' : 'production'
}

/**
 * What `agents.acp` serves, or null when it is off. On, it needs at least one key in `agents.acp.keys` and a payments
 * adapter that charges a delegated token, or the store refuses to start.
 */
export function resolveAcpSettings(
  config: NymbalConfig,
  payments: PaymentsAdapter,
  env: NodeJS.ProcessEnv = process.env,
): AcpSettings | null {
  const acp = config.agents.acp
  if (!acp.enabled) return null
  const keys = acpKeys(acp)
  if (!payments.capabilities().includes('delegated')) {
    const provider = config.commerce.payments.provider
    throw new ConfigError(
      `agents.acp needs a payments provider that charges a delegated token; ${payments.providerName} (commerce.payments.provider ${provider}) does not.`,
      {
        code: 'config.acp_payments_unsupported',
        context: { provider, providerName: payments.providerName },
      },
    )
  }
  return {
    keys,
    links: acp.links,
    ...(acp.merchantId !== undefined && { merchantId: acp.merchantId }),
    environment: environmentOf(config, payments, env),
  }
}
