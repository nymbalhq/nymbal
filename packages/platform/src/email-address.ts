/**
 * The one form an address is stored and looked up in: alert subscriptions and email suppressions both hold it, so a
 * row written from one spelling of a mailbox is found from any other.
 */
export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase()
}
