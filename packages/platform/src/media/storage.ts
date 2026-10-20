export interface MediaStorage {
  capabilities(): readonly string[]
  put(key: string, body: Uint8Array, contentType: string): Promise<{ url: string }>
}
