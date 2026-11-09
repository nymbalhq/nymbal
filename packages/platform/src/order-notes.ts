export interface NoteEntry {
  body: string
  actor: string
  at: string
}

/** An order's `notes` column as entries. A plain string is the shopper's checkout note, from before any entry joined it. */
export function parseNotes(rawNotes: string, createdAt: string): NoteEntry[] {
  if (!rawNotes) return []
  const checkoutNote = [{ body: rawNotes, actor: 'customer', at: createdAt }]
  try {
    const parsed = JSON.parse(rawNotes) as unknown
    return Array.isArray(parsed) ? (parsed as NoteEntry[]) : checkoutNote
  } catch {
    return checkoutNote
  }
}
