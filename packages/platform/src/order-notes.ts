export interface NoteEntry {
  body: string
  actor: string
  at: string
}

/**
 * An order's notes as the admin reads them: the shopper's checkout note first, word for word and never parsed, then
 * the staff and system notes in the order they were added.
 */
export function orderNotes(
  order: { notes: string; createdAt: string },
  staffNotes: readonly NoteEntry[],
): NoteEntry[] {
  const shopper =
    order.notes === '' ? [] : [{ body: order.notes, actor: 'customer', at: order.createdAt }]
  return [...shopper, ...staffNotes]
}
