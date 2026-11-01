/** Where a Settings field's value comes from: the config block, its declared env, a saved value, or nowhere. */
export type SettingSourceName = 'config' | 'env' | 'settings'

/** One declared field as `GET /api/admin/settings` lists it; a secret never carries its value. */
export interface SettingFieldView {
  path: string
  label: string
  secret: boolean
  state: 'unset' | 'set'
  source: SettingSourceName | null
  updatedAt: string | null
  /** Non-secret fields only. */
  value?: unknown
}

/** A slot whose provider declares settings, with its fields. */
export interface SettingsSlotView {
  slot: string
  provider: string
  fields: SettingFieldView[]
}

export interface SettingsListing {
  slots: SettingsSlotView[]
}

/**
 * What a `PUT` or `DELETE` of a field answers: the change applies at the next start. `source` is where the field
 * comes from afterwards: a `DELETE` of a row the config or environment shadows leaves that source.
 */
export interface SettingWriteResult {
  slot: string
  path: string
  state: 'unset' | 'set'
  source: SettingSourceName | null
  restartRequired: true
}
