/** A slug from a name: lower-case ASCII letters and digits, each other run a single hyphen, none at either end. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}
