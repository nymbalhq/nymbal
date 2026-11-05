import type { AgentSurfaceCapabilities } from '@nymbalhq/types'

/** The Agentic Commerce Protocol release this store speaks, the one `API-Version` must name. */
export const ACP_VERSION = '2026-04-17'

export const ACP_BASE_PATH = '/api/acp'

/** The document collection holding what a session's cart cannot: the buyer, the fulfillment details, the cancel mark. */
export const ACP_SESSIONS = 'acp_sessions'

/** What an agent can do through ACP; the admin dashboard names the same. */
export const ACP_CAPABILITIES: Readonly<AgentSurfaceCapabilities> = Object.freeze({
  search: false,
  lookup: false,
  checkout: 'agentic',
})

/** The one payment handler a session offers: a card the agent's platform tokenized as a delegated payment. */
export const ACP_HANDLER_ID = 'card_tokenized'
/** The credential type a delegated payment arrives as: a Shared Payment Token. */
export const ACP_CREDENTIAL = 'spt'

/** The tokenized-card handler, after the protocol's own example handler. */
export function acpHandler(opts: {
  psp: string
  environment: 'test' | 'production'
  merchantId?: string | undefined
}): Record<string, unknown> {
  return {
    id: ACP_HANDLER_ID,
    name: 'dev.acp.tokenized.card',
    display_name: 'Card',
    version: '2026-01-22',
    spec: 'https://acp.dev/handlers/tokenized.card',
    config_schema: 'https://acp.dev/schemas/handlers/tokenized.card/config.json',
    instrument_schemas: ['https://acp.dev/schemas/handlers/tokenized.card/instrument.json'],
    requires_delegate_payment: true,
    requires_pci_compliance: false,
    psp: opts.psp,
    config: {
      psp: opts.psp,
      environment: opts.environment,
      ...(opts.merchantId !== undefined && { merchant_id: opts.merchantId }),
    },
  }
}
