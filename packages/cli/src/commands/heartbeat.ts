import { defineCommand } from 'citty'
import { createLogger, resolveStorePayments } from '@nymbalhq/platform'
import { ConfigError, errorText, type Address, type PaymentsAdapter } from '@nymbalhq/types'
import { loadProject } from '../utils/project.js'
import { runCardCheck, runStoreCheck, type HeartbeatResult } from '../heartbeat/index.js'
import { timed } from '../heartbeat/result.js'

// One heartbeat run, as cron runs it: the store check, then the card check when both card ids are set. A line per
// check (stdout when ok, stderr when not); exit 0 when every check is ok, 1 when one failed, 2 when the heartbeat is
// misconfigured or the store placed a real order for it.

/** Waits for the write, so an exit right after it never cuts the line off (a pipe on macOS is written asynchronously). */
function say(stream: NodeJS.WriteStream, line: string): Promise<void> {
  return new Promise((resolve) => stream.write(`${line}\n`, () => resolve()))
}

async function report(result: HeartbeatResult): Promise<void> {
  if (result.status === 'ok') {
    await say(
      process.stdout,
      `heartbeat: ${result.check} ok: ${result.detail} (${result.durationMs} ms)`,
    )
  } else {
    await say(
      process.stderr,
      `heartbeat: ${result.check} FAILED ${result.status}: ${result.detail}`,
    )
  }
}

/** Misconfigured: one line naming the cause. */
async function misconfigured(cause: string): Promise<never> {
  await say(process.stderr, `heartbeat: ${cause.replace(/\s*\n\s*/g, ' ').trim()}`)
  process.exit(2)
}

export const heartbeatCommand = defineCommand({
  meta: {
    name: 'heartbeat',
    description:
      'Check once that the store takes an order (placed and cancelled) and the saved card is charged and refunded',
  },
  async run() {
    const loaded = await loadProject().catch((err: unknown) => misconfigured(errorText(err)))
    const { config } = loaded
    if (!config.features.heartbeat) {
      return misconfigured(
        `features.heartbeat is off in ${loaded.path}: turn it on, and restart the store, to run the heartbeat`,
      )
    }
    const { store, card } = config.heartbeat
    const saved =
      card.customer !== undefined && card.paymentMethod !== undefined
        ? { customer: card.customer, paymentMethod: card.paymentMethod }
        : undefined
    let payments: PaymentsAdapter | undefined
    // Building the adapter reads the settings saved in the command store, which can be down while the store's API is
    // up: that fails this run's card check. A ConfigError (a key set nowhere, the wrong secrets key) is
    // misconfiguration, refused once the store check has printed. Either way the store is still checked.
    let unbuilt: HeartbeatResult | undefined
    let refused: string | undefined
    if (saved !== undefined) {
      const finish = timed('card')
      try {
        payments = await resolveStorePayments(config, {
          ...(loaded.adapters !== undefined && { adapters: loaded.adapters }),
          env: process.env,
          // Every outcome is a heartbeat line; a log line from building the adapter would only repeat one.
          logger: createLogger({ level: 'silent', pretty: false }),
        })
      } catch (err) {
        if (err instanceof ConfigError) {
          refused = `the payments adapter for heartbeat.card is misconfigured: ${errorText(err)}`
        } else {
          unbuilt = finish('failed', `the payments adapter did not build: ${errorText(err)}`)
        }
      }
      if (payments !== undefined && !payments.capabilities().includes('saved-card')) {
        return misconfigured(
          `heartbeat.card is set, but the payments provider ${payments.providerName} cannot charge a saved card`,
        )
      }
    }

    const storefrontUrl = config.heartbeat.storefrontUrl ?? config.store.url
    const storeCheck = await runStoreCheck({
      apiUrl: config.heartbeat.apiUrl ?? `http://127.0.0.1:${config.http.port}`,
      ...(storefrontUrl !== undefined && { storefrontUrl }),
      // The config's refinement requires both while features.heartbeat is on.
      email: store.email!,
      address: store.address! as Address,
      ...(store.sku !== undefined && { sku: store.sku }),
    })
    await report(storeCheck)
    if (refused !== undefined) return misconfigured(refused)
    const cardCheck =
      payments === undefined || saved === undefined
        ? unbuilt
        : await runCardCheck(payments, {
            ...saved,
            amountMinor: card.amountMinor,
            currency: config.store.currency,
          })
    if (cardCheck !== undefined) await report(cardCheck)

    if (storeCheck.status === 'unrecognised') process.exit(2)
    process.exit(storeCheck.status === 'ok' && (cardCheck?.status ?? 'ok') === 'ok' ? 0 : 1)
  },
})
