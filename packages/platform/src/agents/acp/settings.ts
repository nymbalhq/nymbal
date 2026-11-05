import { ACP_KEY_MIN_LENGTH, type NymbalConfig } from '@nymbalhq/config'
import { ConfigError, type PaymentsAdapter } from '@nymbalhq/types'

export const ACP_KEY_ENV = 'NYMBAL_ACP_API_KEY'

export interface AcpSettings {
  apiKey: string
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
 * What `agents.acp` serves, or null when it is off. On, it needs a key of at least 32 characters (the config's, else
 * `NYMBAL_ACP_API_KEY`) and a payments adapter that charges a delegated token, or the store refuses to start.
 */
export function resolveAcpSettings(
  config: NymbalConfig,
  payments: PaymentsAdapter,
  env: NodeJS.ProcessEnv = process.env,
): AcpSettings | null {
  const acp = config.agents.acp
  if (!acp.enabled) return null
  const apiKey = acp.apiKey ?? env[ACP_KEY_ENV]
  if (apiKey === undefined || apiKey === '') {
    throw new ConfigError(
      `agents.acp is enabled with no key: set ${ACP_KEY_ENV} (or agents.acp.apiKey) to a secret of at least ${ACP_KEY_MIN_LENGTH} characters (\`openssl rand -base64 32\`).`,
      { code: 'config.acp_key_missing' },
    )
  }
  if (apiKey.length < ACP_KEY_MIN_LENGTH) {
    throw new ConfigError(
      `The ACP key (${ACP_KEY_ENV} or agents.acp.apiKey) is ${apiKey.length} characters; it must be at least ${ACP_KEY_MIN_LENGTH}.`,
      { code: 'config.acp_key_short', context: { length: apiKey.length } },
    )
  }
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
    apiKey,
    links: acp.links,
    ...(acp.merchantId !== undefined && { merchantId: acp.merchantId }),
    environment: environmentOf(config, payments, env),
  }
}
