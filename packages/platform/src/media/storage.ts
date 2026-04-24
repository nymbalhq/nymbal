export interface MediaStorage {
  put(key: string, body: Uint8Array, contentType: string): Promise<{ url: string }>
}
