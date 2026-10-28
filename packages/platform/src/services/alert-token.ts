import { randomBytes } from 'node:crypto'

/** A confirm or unsubscribe link's bearer credential: 32 random bytes, base64url (43 characters). */
export function newAlertToken(): string {
  return randomBytes(32).toString('base64url')
}
