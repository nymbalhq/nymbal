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

/** What a `PUT` or `DELETE` of a field answers: the change applies at the next start. */
export interface SettingWriteResult {
  slot: string
  path: string
  state: 'unset' | 'set'
  source: 'settings' | null
  restartRequired: true
}
