import { describe, expect, it } from 'vitest'
import { CheckoutError, NymbalError, ValidationError } from '@nymbalhq/types'
import { renderError } from './envelope.js'

// P1-06 AC-17: `renderError` maps the errors a shopper can fix to 4xx and keeps faults at 5xx. `finalize_failed`
// stays 500 because the Stripe retry (P1-05) depends on a non-2xx. Kills: every `NymbalError` rendered as 500.

type CheckoutCode = ConstructorParameters<typeof CheckoutError>[0]

const checkoutStatus: Record<CheckoutCode, number> = {
  cart_empty: 409,
  out_of_stock: 409,
  reservation_failed: 409,
  variant_missing: 422,
  finalize_failed: 500,
}

interface Rendered {
  status: number
  body: { error?: { code: string } }
}

describe('renderError', () => {
  it('AC-17: ValidationError renders 400 with its own code, while any other NymbalError stays 500', () => {
    const error = new ValidationError('qty must be positive')
    const rendered = renderError(error) as Rendered
    expect(rendered.status).toBe(400)
    expect(rendered.body.error?.code).toBe(error.code)
    const other = renderError(new NymbalError('something.else', 'boom')) as Rendered
    expect(other.status).toBe(500)
    expect(rendered.status).toBeLessThan(other.status)
  })

  it('AC-17: CheckoutError cart_empty, out_of_stock and reservation_failed render 409, variant_missing 422, finalize_failed 500, each with its own code', () => {
    for (const [code, status] of Object.entries(checkoutStatus) as Array<[CheckoutCode, number]>) {
      const error = new CheckoutError(code, code)
      const rendered = renderError(error) as Rendered
      expect(rendered.status, code).toBe(status)
      expect(rendered.body.error?.code, code).toBe(error.code)
    }
  })
})
