import type { APIRequestContext } from '@playwright/test'
import type { WebhookAnswer } from './alerts'
import { API_URL } from './csrf'

// A provider's webhook post as the provider sends it: the exact bytes it signed and the headers it signs in. A body
// re-serialised after signing (an object handed to Playwright's `data`) no longer matches a signature over the raw
// body, so the caller gives the signed string itself.

/** `POST /api/webhooks/<name>` with `rawBody` sent byte for byte and `headers` as given; no browser, no CSRF pair. */
export async function postSignedWebhook(
  request: APIRequestContext,
  name: string,
  signed: { rawBody: Buffer | string; headers: Record<string, string> },
): Promise<WebhookAnswer> {
  const bytes =
    typeof signed.rawBody === 'string' ? Buffer.from(signed.rawBody, 'utf8') : signed.rawBody
  // A carrier's tracking update reaches a store only as the provider's webhook: no page or route of the store's own
  // makes one, so the journey posts what EasyPost would, signed with the store's secret.
  // eslint-disable-next-line no-restricted-syntax -- the provider's post is the only way a tracking update enters the store
  const res = await request.post(`${API_URL}/api/webhooks/${name}`, {
    headers: signed.headers,
    data: bytes,
  })
  const text = await res.text()
  let parsed: { data?: Record<string, unknown>; error?: WebhookAnswer['error'] } = {}
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    // not an envelope: the status and the correlation id say what happened
  }
  return {
    status: res.status(),
    ...(parsed.data !== undefined && { data: parsed.data }),
    ...(parsed.error !== undefined && { error: parsed.error }),
    correlationId: res.headers()['x-correlation-id'] ?? '',
  }
}
