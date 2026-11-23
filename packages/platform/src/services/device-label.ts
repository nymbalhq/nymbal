/** What a sign-in whose `User-Agent` names no known browser or system is listed as. */
export const UNKNOWN_DEVICE = 'Unknown device'

/** Past this many characters a header is not read: the label costs the same for any header. */
const MAX_READ = 512

// First match wins. Edge, Opera and Samsung Internet also say Chrome and Safari, and Chrome also says Safari; iPhones
// and iPads say "like Mac OS X", and Android says Linux. Headless Chrome (automated browsers) says HeadlessChrome.
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/\b(?:Edg|EdgA|EdgiOS)\//, 'Edge'],
  [/\bOPR\//, 'Opera'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\b(?:Chrome|HeadlessChrome|CriOS)\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
]

const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\biPad\b/, 'iPad'],
  [/\biPhone\b/, 'iPhone'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
]

function firstMatch(header: string, words: ReadonlyArray<readonly [RegExp, string]>) {
  return words.find(([pattern]) => pattern.test(header))?.[1]
}

/**
 * The label a signed-in device is listed under, built only from fixed words, so nothing a client sends is shown back:
 * `<Browser> on <OS>`, either alone, or `Unknown device`.
 */
export function describeDevice(userAgent: string | undefined): string {
  const header = (userAgent ?? '').slice(0, MAX_READ)
  const browser = firstMatch(header, BROWSERS)
  const system = firstMatch(header, SYSTEMS)
  if (browser !== undefined && system !== undefined) return `${browser} on ${system}`
  return browser ?? system ?? UNKNOWN_DEVICE
}
