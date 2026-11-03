import sanitizeHtml from 'sanitize-html'

const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  'ul',
  'ol',
  'li',
  'h2',
  'h3',
  'h4',
  'blockquote',
  'a',
]

/** Dropped with everything inside them; every other tag outside the allowlist is dropped and its text kept. */
const DROPPED_WITH_CONTENT = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'template',
  'noscript',
  'textarea',
  'option',
]

const LINK_SCHEME = /^(?:https?|mailto):/i
const LINK_REL = 'nofollow noopener noreferrer'

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: { a: ['href', 'rel'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: {},
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  nonTextTags: DROPPED_WITH_CONTENT,
  disallowedTagsMode: 'discard',
  transformTags: {
    a: (tagName, attribs) => {
      const href = attribs['href']?.trim()
      return {
        tagName,
        attribs: {
          ...(href !== undefined && LINK_SCHEME.test(href) && { href }),
          rel: LINK_REL,
        },
      }
    },
  },
}

/**
 * A product description as the store keeps it: an HTML fragment of the allowlisted tags, links only to http(s) and
 * mailto with `rel="nofollow noopener noreferrer"`, no other attribute, and text `<` and `&` written as entities.
 * Sanitising its own output changes nothing.
 */
export function sanitizeDescription(html: string): string {
  return sanitizeHtml(html, OPTIONS)
}
