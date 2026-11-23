import fc from 'fast-check'

// SMTP enhanced status codes (RFC 3463, `class.subject.detail`) as providers report them on a permanent failure: alone
// in a field of their own, or inside the receiving server's reply text, which may also hold IPv4 addresses whose
// dotted digits look like a status (`5.7.1.9`, `203.0.5.7`). A status of subject 7 is the recipient's server refusing
// the sender (security or policy); any other subject names the mailbox.

export interface Status {
  /** The status as written, `5.S.D`. */
  code: string
  /** True when its subject is 7. */
  policy: boolean
}

/** A permanent-failure status `5.S.D`, subject 7 about half the time. */
export const status: fc.Arbitrary<Status> = fc
  .tuple(
    fc.oneof(fc.constant(7), fc.integer({ min: 0, max: 20 })),
    fc.integer({ min: 0, max: 999 }),
  )
  .map(([subject, detail]) => ({ code: `5.${subject}.${detail}`, policy: subject === 7 }))

/** An IPv4 address, often one whose digits read like a policy status. */
export const ipV4: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('203.0.5.7', '5.7.1.9', '10.5.7.1', '5.7.26.1', '198.51.5.7'),
  fc.ipV4(),
)

/** Reply words with no digits, so no status can form from them. */
const word = fc.constantFrom(
  'Service unavailable;',
  'client host',
  'blocked using',
  'Spamhaus;',
  'Message rejected',
  'mailbox unavailable',
  'sender denied',
  'see',
  '<user@example.test>',
  'https://example.test/why',
)

const words = fc.array(word, { maxLength: 4 }).map((ws) => ws.join(' '))

/** An IPv4 address as reply text carries it: bare or bracketed. */
const ipText = fc.tuple(ipV4, fc.boolean()).map(([ip, bracketed]) => (bracketed ? `[${ip}]` : ip))

/** Reply text that holds no status at all: words, and IPv4 addresses anywhere among them. */
export const noStatusText: fc.Arbitrary<string> = fc
  .array(fc.oneof(word, ipText), { minLength: 1, maxLength: 5 })
  .map((parts) => parts.join(' '))

/**
 * Reply text whose one status is `code`: an optional basic reply code (`550`), then IPv4 addresses before or after it
 * among words, the status followed by a space or punctuation.
 */
export function replyWith(code: string): fc.Arbitrary<string> {
  return fc
    .record({
      basic: fc.constantFrom('550 ', '554 ', '553 ', 'smtp; 550 ', ''),
      before: fc.option(ipText, { nil: undefined }),
      lead: words,
      after: fc.option(ipText, { nil: undefined }),
      end: fc.constantFrom(' ', '; ', ': ', ' (', ''),
      tail: words,
    })
    .map(({ basic, before, lead, after, end, tail }) =>
      [
        `${basic}${before === undefined ? '' : `${before} `}${lead === '' ? '' : `${lead} `}${code}${end}`,
        after ?? '',
        tail,
      ]
        .filter((part) => part !== '')
        .join(' ')
        .trimEnd(),
    )
}
