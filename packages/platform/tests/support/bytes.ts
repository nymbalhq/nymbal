// P3-07 support: the bytes of a stored binary column (a buffer, hex or base64 text), and one of them flipped in the
// representation it came in, for the AC-1 and AC-6 tamper cases. Nothing here knows which representation the store picks.

const HEX = /^(?:[0-9a-f]{2})+$/i

/** The bytes a stored binary column holds, whether the store keeps a buffer, hex or base64 text. */
export function bytesOf(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (typeof value === 'string') {
    return HEX.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64')
  }
  throw new Error(`not a binary value: ${typeof value}`)
}

/** `value` with one byte flipped (at `index` modulo its length), in the representation it came in. */
export function flipByte(value: unknown, index = 0): unknown {
  const bytes = bytesOf(value)
  if (bytes.length === 0) throw new Error('flipByte: no bytes to flip')
  const at = index % bytes.length
  bytes[at] = bytes[at]! ^ 0x01
  if (Buffer.isBuffer(value)) return bytes
  if (value instanceof Uint8Array) return new Uint8Array(bytes)
  const text = value as string
  if (HEX.test(text)) return bytes.toString('hex')
  return /[-_]/.test(text) ? bytes.toString('base64url') : bytes.toString('base64')
}
