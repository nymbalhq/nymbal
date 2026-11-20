import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { msOf, type OpenStore, type PasswordStore } from '../support/password-reset.js'
import { agedPending, customerRows, DAY_MS } from '../support/unconfirmed-accounts.js'
import { accountStateOf, openVerificationStore } from '../support/verification.js'

// The app starts the unconfirmed-account sweeper beside the others, with the store's resolved policy: two kernels
// built together on a short interval, one that confirms sign-ups and one that does not.

const INTERVAL_MS = 50
const IDLE_DAYS = 31

const open: OpenStore = (opts) =>
  createKernel({
    dialect: 'sqlite',
    ...opts,
    appOptions: { ...opts.appOptions, unconfirmedAccountSweep: { intervalMs: INTERVAL_MS } },
  })

describe('the unconfirmed-account sweeper in the app', () => {
  let required: PasswordStore
  let off: PasswordStore

  beforeAll(async () => {
    ;[required, off] = await Promise.all([
      openVerificationStore(open, { verification: 'required' }),
      openVerificationStore(open, { verification: 'off' }),
    ])
  }, 60_000)

  afterAll(async () => {
    await required?.close()
    await off?.close()
  })

  // Defect: the sweeper is written and tested alone but never started, or started without the store's policy.
  it('AC-8: with no call from the test, the required kernel removes its pending account idle 31 days, then one more written after it; the off kernel’s pending account of the same age is byte-equal all along', async () => {
    const kept = await agedPending(off, 'ac8-off', IDLE_DAYS)
    const keptBefore = await accountStateOf(off, kept.customerId)
    // Past the 30 days, so only the policy keeps it.
    expect(Date.now() - msOf(keptBefore.customer.updated_at)).toBeGreaterThan(30 * DAY_MS)
    const first = await agedPending(required, 'ac8-required', IDLE_DAYS)

    await vi.waitFor(async () => expect(await customerRows(required, first.customerId)).toBe(0), {
      timeout: 10_000,
      interval: 20,
    })
    // A second removal on the same interval is one more pass of every sweeper started with it.
    const second = await agedPending(required, 'ac8-required-next', IDLE_DAYS)
    await vi.waitFor(async () => expect(await customerRows(required, second.customerId)).toBe(0), {
      timeout: 10_000,
      interval: 20,
    })

    expect(await accountStateOf(off, kept.customerId)).toEqual(keptBefore)
  })
})
