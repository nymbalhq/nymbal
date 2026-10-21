// The P2-14 stack table, written out here from the spec rather than imported from scripts/stack.ts, so that the
// tests of the gate, the Playwright config and the CLI check them against the spec and not against the module itself.

/** Slot 0: today's ports, which CI and a single checkout keep. */
export const SLOT0_PORTS = {
  api: 3001,
  astro: 4321,
  nextjs: 3000,
  customApi: 3011,
  astroCustom: 4331,
  nextjsCustom: 3010,
  noSearchApi: 3021,
  astroNoSearch: 4341,
  nextjsNoSearch: 3020,
  walkApi: 3031,
  walkAstro: 4351,
  walkNextjs: 3030,
  postgres: 54329,
  redis: 63799,
  mailpitSmtp: 11025,
  mailpitUi: 18025,
  minio: 59000,
} as const

export type PortField = keyof typeof SLOT0_PORTS

export const PORT_FIELDS = Object.keys(SLOT0_PORTS) as PortField[]

export type ExpectedBlock = { slot: number; project: string } & Record<PortField, number>

/** The block the spec gives slot `k`: every slot 0 port plus 100k, and the compose project `nymbal-s<k>` (`nymbal` at 0). */
export function expectedBlock(slot: number): ExpectedBlock {
  const ports = Object.fromEntries(
    PORT_FIELDS.map((field) => [field, SLOT0_PORTS[field] + 100 * slot]),
  ) as Record<PortField, number>
  return { slot, project: slot === 0 ? 'nymbal' : `nymbal-s${slot}`, ...ports }
}

/** The variables compose.yaml reads its host ports from, by the block field each takes. */
export const COMPOSE_PORT_VARS: Record<string, PortField> = {
  NYMBAL_POSTGRES_PORT: 'postgres',
  NYMBAL_REDIS_PORT: 'redis',
  NYMBAL_MAILPIT_SMTP_PORT: 'mailpitSmtp',
  NYMBAL_MAILPIT_UI_PORT: 'mailpitUi',
  NYMBAL_MINIO_PORT: 'minio',
}
