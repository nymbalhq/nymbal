import { PAYMENT_SOURCES as PAY } from '@nymbalhq/web-components/payment-sources'

/**
 * The content security policy every page answers. A script, style, font, frame or browser-side call from anywhere
 * else (analytics, chat, a web font) is refused until it is named here; the payment step's come with its drivers.
 * Scripts stay 'unsafe-inline': escaping is the defence against an injected inline script. `apiUrl` empty is the API
 * on the page's own origin. `dev` adds nothing: the dev server loads nothing this refuses.
 */
export function pagePolicy({ apiUrl }: { apiUrl: string; dev: boolean }): string {
  const api = apiUrl === '' ? '' : ` ${new URL(apiUrl).origin}`
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' ${PAY.script.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self'${api} data: blob: https:`,
    "font-src 'self' data:",
    `connect-src 'self'${api} ${PAY.connect.join(' ')}`,
    `frame-src ${PAY.frame.join(' ')}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ')
}
