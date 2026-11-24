import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { describeDevice } from './device-label.js'

// The label a signed-in device is listed under, made on the server from its User-Agent at sign-in. It is built only
// from two fixed word lists, so nothing a client chose is ever shown on the account's other devices, and it reads at
// most the first 512 characters of the header.

const BROWSERS = ['Chrome', 'Safari', 'Firefox', 'Edge', 'Opera', 'Samsung Internet']
const SYSTEMS = ['Windows', 'macOS', 'iPhone', 'iPad', 'Android', 'Linux', 'ChromeOS']
const UNKNOWN = 'Unknown device'

/** Every answer the vocabulary allows: a browser on a system, either alone, or the unknown label. */
const VOCABULARY = new Set([
  UNKNOWN,
  ...BROWSERS,
  ...SYSTEMS,
  ...BROWSERS.flatMap((browser) => SYSTEMS.map((system) => `${browser} on ${system}`)),
])

/** What real headers are made of, so generated strings land on the parser's branches and not only on noise. */
const fragment = fc.oneof(
  fc.constantFrom(
    'Mozilla/5.0',
    '(Windows NT 10.0; Win64; x64)',
    '(Macintosh; Intel Mac OS X 10_15_7)',
    '(iPhone; CPU iPhone OS 17_1 like Mac OS X)',
    '(iPad; CPU OS 17_1 like Mac OS X)',
    '(Linux; Android 13; SM-S911B)',
    '(X11; Linux x86_64)',
    '(X11; CrOS x86_64 14541.0.0)',
    'AppleWebKit/537.36 (KHTML, like Gecko)',
    'Chrome/120.0.0.0',
    'Safari/537.36',
    'Version/17.1 Mobile/15E148 Safari/604.1',
    'Edg/120.0.0.0',
    'OPR/105.0.0.0',
    'SamsungBrowser/23.0',
    'Gecko/20100101 Firefox/121.0',
    'curl/8.0',
    '<img src=x onerror=alert(1)>',
  ),
  fc.string({ maxLength: 40 }),
)

const userAgent = fc.oneof(
  fc.string({ maxLength: 600 }),
  fc.array(fragment, { maxLength: 12 }).map((parts) => parts.join(' ')),
)

describe('AC-2: the device label', () => {
  // Defect: the label echoes part of the header (a client-chosen name reaches every other device's list), or a
  // malformed header throws and fails the sign-in.
  it('AC-2: property: for any user agent the label is Unknown device or built only from the two word lists, and nothing throws', () => {
    fc.assert(
      fc.property(fc.option(userAgent, { nil: undefined }), (header) => {
        expect(VOCABULARY.has(describeDevice(header)), JSON.stringify(header)).toBe(true)
      }),
      { numRuns: 2_000 },
    )
  })

  // Defect: the parser scans the whole header, so a 100 000-character one costs every sign-in or names a device from
  // text past the limit.
  it('AC-2: property: the label of any user agent is the label of its first 512 characters', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 512, maxLength: 700 }),
        fc.array(fragment, { maxLength: 6 }).map((parts) => parts.join(' ')),
        (head, tail) => {
          const header = `${head}${tail}`
          expect(describeDevice(header)).toBe(describeDevice(header.slice(0, 512)))
        },
      ),
      { numRuns: 300 },
    )
  })

  it('AC-2: a 100 000-character user agent answers a label of the vocabulary, and names nothing from past the first 512 characters', () => {
    const padding = 'x'.repeat(600)
    const label = describeDevice(`${padding}${'Firefox/121.0 (Windows NT 10.0) '.repeat(3_000)}`)

    expect(VOCABULARY.has(label)).toBe(true)
    expect(label).toBe(UNKNOWN)
    expect(VOCABULARY.has(describeDevice('('.repeat(100_000)))).toBe(true)
  })

  // Defect: Edge and the other Chromium browsers read as Chrome or Safari (their headers say both), or Android reads
  // as Linux (its header says both).
  it.each([
    {
      device: 'desktop Chrome on macOS',
      header:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      label: 'Chrome on macOS',
    },
    {
      device: 'Safari on iPhone',
      header:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
      label: 'Safari on iPhone',
    },
    {
      device: 'Safari on iPad',
      header:
        'Mozilla/5.0 (iPad; CPU OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
      label: 'Safari on iPad',
    },
    {
      device: 'Firefox on Windows',
      header: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      label: 'Firefox on Windows',
    },
    {
      device: 'Edge on Windows, whose header also says Chrome and Safari',
      header:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
      label: 'Edge on Windows',
    },
    {
      device: 'Chrome on Android, whose header also says Linux',
      header:
        'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      label: 'Chrome on Android',
    },
    {
      device: 'Samsung Internet on Android, whose header also says Chrome',
      header:
        'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
      label: 'Samsung Internet on Android',
    },
    {
      device: 'headless Chrome, whose header also says Safari',
      header:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36',
      label: 'Chrome on macOS',
    },
    {
      device: 'Chrome on iPhone',
      header:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1',
      label: 'Chrome on iPhone',
    },
    { device: 'a browser on no known system', header: 'Firefox/121.0', label: 'Firefox' },
    {
      device: 'a known system with no known browser',
      header: 'SomeApp/2.1 (Windows NT 10.0; Win64; x64)',
      label: 'Windows',
    },
    { device: 'curl', header: 'curl/8.0', label: UNKNOWN },
    { device: 'an empty header', header: '', label: UNKNOWN },
    { device: 'no header', header: undefined, label: UNKNOWN },
  ])('AC-2: $device is labelled $label', ({ header, label }) => {
    expect(describeDevice(header)).toBe(label)
  })
})
