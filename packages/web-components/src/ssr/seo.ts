/**
 * JSON for a `<script type="application/ld+json">` element: `JSON.stringify` with `<`, `>`, `&`, U+2028 and U+2029
 * written as JSON escapes, so no product text can close the element (`</script>`) or open a comment, and the JSON
 * parses to the same value.
 */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

/** The entities a sanitised description holds: the API writes every other character as itself. */
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' }

/**
 * A product description (the sanitised HTML fragment the API serves) as plain text, for a meta tag or JSON-LD: tags
 * dropped, block boundaries made spaces, entities decoded, whitespace collapsed. None reads as ''.
 */
export function descriptionText(html: string | undefined): string {
  return (html ?? '')
    .replace(/<\/?(?:p|br|li|ul|ol|h\d|blockquote)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot);/g, (entity) => ENTITIES[entity]!)
    .replace(/\s+/g, ' ')
    .trim()
}
