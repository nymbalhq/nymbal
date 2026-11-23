import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CommandStore } from '../../../src/db/command-store.js'
import {
  createEmailSuppressionRepository,
  type EmailSuppressionReason,
} from '../../../src/repositories/email-suppression.js'

// The suppression list as a merchant reads it, on one dialect: every suppressed address, newest first and ties by
// address, normalised, with the total of all rows whatever the page holds.

export interface EmailSuppressionListOptions {
  /** A command store on a database of its own, migrated to the newest migration. */
  open(): Promise<CommandStore>
  propertyRuns: number
}

/** A few instants, so rows often share a time and the tie order shows. */
const SHARED = ['2026-11-01T10:00:00.000Z', '2026-11-02T09:30:00.000Z', '2026-11-03T18:45:00.000Z']

const instant = fc.oneof(
  fc.constantFrom(...SHARED),
  fc
    .date({
      min: new Date('2025-01-01T00:00:00.000Z'),
      max: new Date('2027-01-01T00:00:00.000Z'),
      noInvalidDate: true,
    })
    .map((d) => d.toISOString()),
)

interface Row {
  email: string
  spelled: string
  reason: EmailSuppressionReason
  at: string
}

/** Distinct normalised addresses, each written in some spelling: case changed, spaces around. */
const rows: fc.Arbitrary<Row[]> = fc
  .uniqueArray(
    fc.emailAddress().map((e) => e.toLowerCase()),
    { maxLength: 8 },
  )
  .chain((emails) =>
    fc.tuple(
      ...emails.map((email) =>
        fc
          .record({
            upper: fc.boolean(),
            padded: fc.boolean(),
            reason: fc.constantFrom<EmailSuppressionReason>('hard_bounce', 'complaint'),
            at: instant,
          })
          .map(({ upper, padded, reason, at }) => ({
            email,
            spelled: `${padded ? '  ' : ''}${upper ? email.toUpperCase() : email}${padded ? ' ' : ''}`,
            reason,
            at,
          })),
      ),
    ),
  )

const byEmail = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export function emailSuppressionListSuite(
  dialect: string,
  opts: EmailSuppressionListOptions,
): void {
  describe(`EmailSuppressionRepository.list (${dialect})`, () => {
    let store: CommandStore

    beforeAll(async () => {
      store = await opts.open()
    }, 60_000)

    afterAll(async () => {
      await store?.close()
    })

    it(`AC-11: property: list answers the suppressed addresses normalised, newest first and ties by address, at most limit of them, with the total of all rows (${dialect})`, async () => {
      const repo = createEmailSuppressionRepository(store)
      await fc.assert(
        fc.asyncProperty(rows, fc.nat({ max: 10 }), async (written, pick) => {
          const limit = 1 + (pick % (written.length + 2))
          try {
            for (const [i, row] of written.entries()) {
              await store.transaction((tx) =>
                repo.suppress(tx, {
                  email: row.spelled,
                  reason: row.reason,
                  eventId: `event-${i}`,
                  at: new Date(row.at),
                }),
              )
            }

            const page = await store.read((tx) => repo.list(tx, { limit }))

            const model = written
              .map((row) => ({ email: row.email, reason: row.reason, createdAt: row.at }))
              .sort((a, b) => byEmail(b.createdAt, a.createdAt) || byEmail(a.email, b.email))
            expect(page, `limit ${limit}`).toEqual({
              rows: model.slice(0, limit),
              total: written.length,
            })
          } finally {
            for (const row of written) await store.transaction((tx) => repo.clear(tx, row.email))
          }
        }),
        { numRuns: opts.propertyRuns },
      )
    })
  })
}
