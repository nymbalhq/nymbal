import { rawClients, type CommandStore, type ReadTx, type Tx } from '../db/command-store.js'
import type { Repositories } from './index.js'
import type { VariantInsert } from './variant.js'

// AC-14: a repository write does not compile without a transaction handle, with the ReadTx that store.read hands its
// callback, or with the raw Drizzle client; a read does not compile without a handle. A write with a Tx and a read
// with a ReadTx compile. Checked by `pnpm typecheck` (tsc), never executed.

declare const store: CommandStore
declare const repos: Repositories
declare const tx: Tx
declare const readTx: ReadTx
declare const variant: VariantInsert

// A write with no handle.
// @ts-expect-error a write needs a Tx
void repos.variant.insert(variant)

// A write with the ReadTx that store.read hands its callback.
void store.read(async (r) => {
  // @ts-expect-error a ReadTx is not a Tx
  await repos.variant.insert(r, variant)
})
// @ts-expect-error a ReadTx is not a Tx
void repos.variant.decrementStock(readTx, 'variant-id', 1, new Date())

// A write with the raw Drizzle client.
// @ts-expect-error the raw client is not a Tx
void repos.variant.insert(rawClients(store).db, variant)

// A read with no handle.
// @ts-expect-error a read needs a ReadTx
void repos.variant.findById('variant-id')

// These compile.
void store.transaction(async (t) => repos.variant.insert(t, variant))
void store.transaction(async (t) => repos.variant.decrementStock(t, 'variant-id', 1, new Date()))
void store.read(async (r) => repos.variant.findById(r, 'variant-id'))
void repos.variant.findById(readTx, 'variant-id')
// A Tx is a ReadTx: reads inside a transaction take the transaction's handle.
void repos.variant.findById(tx, 'variant-id')
void repos.order.findByPaymentIntentId(tx, 'pi_x')
void repos.inventoryReservation.findExpiredBefore(readTx, new Date())
