import type { NymbalConfig } from '@nymbalhq/config'
import {
  EVT_SETTINGS_CHANGED,
  SECRET_MIN_LENGTH,
  type AdapterSetting,
  type HttpAdapter,
  type RequestContext,
  type SettingFieldView,
  type SettingsListing,
  type SettingWriteResult,
} from '@nymbalhq/types'
import type { EventPublisher } from '../events/publisher.js'
import type { SettingRow, SettingsRepository } from '../repositories/settings.js'
import { encrypt, keyProblem, readSecretsKey, settingAad } from '../settings/crypto.js'
import { listStoredSettings, type DeclaredSlot } from '../settings/load.js'
import { getPath, sourceOf } from '../settings/resolve.js'
import { addSecret } from '../settings/secret-set.js'
import { fail, ok, renderError } from './envelope.js'
import { requireRole } from './role-middleware.js'

export interface RegisterAdminSettingsRoutesDeps {
  config: NymbalConfig
  slots: readonly DeclaredSlot[]
  settings: SettingsRepository
  publisher: EventPublisher
}

/**
 * The admin's Settings: a listing of each declared field and where it is set from, never a secret's
 * value; a write for a field the config and environment leave unset, which applies at the next start.
 */
export function registerAdminSettingsRoutes(
  adapter: HttpAdapter,
  deps: RegisterAdminSettingsRoutesDeps,
): void {
  const { config, slots, settings, publisher } = deps
  const store = settings.store

  const blockOf = (slot: DeclaredSlot['slot']) => config.commerce[slot].config ?? {}

  function view(slot: DeclaredSlot, decl: AdapterSetting, row: SettingRow | undefined) {
    const block = blockOf(slot.slot)
    const source = sourceOf(block, decl, process.env, row !== undefined)
    const field: SettingFieldView = {
      path: decl.path,
      label: decl.label,
      secret: decl.secret,
      state: source === null ? 'unset' : 'set',
      source,
      updatedAt: source === 'settings' && row !== undefined ? row.updatedAt.toISOString() : null,
    }
    if (!decl.secret) {
      field.value =
        source === 'config'
          ? getPath(block, decl.path)
          : source === 'env'
            ? process.env[decl.env!]
            : source === 'settings'
              ? row!.plain
              : null
    }
    return field
  }

  /** The declared field, or the 404 / 409 answer that refuses a write to it. */
  function writable(ctx: RequestContext) {
    const { slot, path } = ctx.params as { slot: string; path: string }
    const owner = slots.find((s) => s.slot === slot)
    const decl = owner?.declared.find((d) => d.path === path)
    if (owner === undefined || decl === undefined) {
      return {
        refused: fail(
          'settings.unknown_field',
          `${slot}.${path} is not a field this store's providers let Settings fill`,
          404,
        ),
      }
    }
    const source = sourceOf(blockOf(owner.slot), decl, process.env, false)
    if (source !== null) {
      const where = source === 'env' ? decl.env! : 'nymbal.config.ts'
      return {
        refused: fail(
          'settings.set_by_environment',
          `${slot}.${path} is set by ${where}; change it there`,
          409,
        ),
      }
    }
    return { owner, decl }
  }

  adapter.registerRoute(
    'GET',
    '/api/admin/settings',
    requireRole('admin', async () => {
      try {
        const rows = await listStoredSettings(store)
        return ok<SettingsListing>({
          slots: slots.map((slot) => ({
            slot: slot.slot,
            provider: slot.provider,
            fields: slot.declared.map((decl) =>
              view(
                slot,
                decl,
                rows.find((r) => r.slot === slot.slot && r.path === decl.path),
              ),
            ),
          })),
        })
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  adapter.registerRoute(
    'PUT',
    '/api/admin/settings/:slot/:path',
    requireRole('admin', async (ctx) => {
      try {
        const target = writable(ctx)
        if (target.refused !== undefined) return target.refused
        const { owner, decl } = target
        const { value } = ctx.body as { value: string }
        // The scrub set skips values this short, so a shorter secret would reach logs and error bodies unmasked.
        if (decl.secret && value.length < SECRET_MIN_LENGTH) {
          return fail(
            'settings.secret_too_short',
            `${owner.slot}.${decl.path} is a secret: it needs at least ${SECRET_MIN_LENGTH} characters`,
            400,
            { slot: owner.slot, path: decl.path, minLength: SECRET_MIN_LENGTH },
          )
        }
        const base = {
          slot: owner.slot,
          path: decl.path,
          updatedAt: new Date(),
          updatedBy: ctx.auth?.userId ?? null,
        }
        let row: SettingRow
        if (decl.secret) {
          const key = readSecretsKey(process.env)
          if (!key.ok) {
            return fail(
              'settings.key_missing',
              `${keyProblem(key.reason)}: the store needs it to save secrets in Settings`,
              503,
            )
          }
          addSecret(value)
          const sealed = encrypt(key.key, settingAad(owner.slot, decl.path), value)
          row = { ...base, ...sealed, plain: null, keyId: key.id }
        } else {
          row = { ...base, ciphertext: null, iv: null, tag: null, keyId: null, plain: value }
        }
        await store.transaction(async (tx) => {
          await settings.put(tx, row)
          await publisher.publish(EVT_SETTINGS_CHANGED, {
            slot: owner.slot,
            path: decl.path,
            source: 'settings',
          })
        })
        return ok<SettingWriteResult>({
          slot: owner.slot,
          path: decl.path,
          state: 'set',
          source: 'settings',
          restartRequired: true,
        })
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  adapter.registerRoute(
    'DELETE',
    '/api/admin/settings/:slot/:path',
    requireRole('admin', async (ctx) => {
      try {
        const target = writable(ctx)
        if (target.refused !== undefined) return target.refused
        const { owner, decl } = target
        await store.transaction(async (tx) => {
          await settings.delete(tx, owner.slot, decl.path)
          await publisher.publish(EVT_SETTINGS_CHANGED, {
            slot: owner.slot,
            path: decl.path,
            source: null,
          })
        })
        return ok<SettingWriteResult>({
          slot: owner.slot,
          path: decl.path,
          state: 'unset',
          source: null,
          restartRequired: true,
        })
      } catch (err) {
        return renderError(err)
      }
    }),
  )
}
