import { PAYMENT_SOURCES as PAY } from '@nymbalhq/web-components/payment-sources'

/**
 * Every page's content security policy: a script, style, frame or call from elsewhere is refused until it is named here
 * (the payment step's come with its drivers). Scripts keep 'unsafe-inline', as `/` and the product page are cached
 * whole. `apiUrl` empty is the API on the page's own origin; `dev` adds the 'unsafe-eval' React's dev build needs.
 * @param {{ apiUrl: string; dev: boolean }} options
 */
export function pagePolicy({ apiUrl, dev }) {
  const api = apiUrl === '' ? '' : ` ${new URL(apiUrl).origin}`
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' ${PAY.script.join(' ')}${dev ? " 'unsafe-eval'" : ''}`,
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
