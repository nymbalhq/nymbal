/** Where uploaded and imported media go. `put` returns the URL the stored bytes are served from. */
export interface MediaStorage {
  capabilities(): readonly string[]
  put(key: string, body: Uint8Array, contentType: string): Promise<{ url: string }>
}
