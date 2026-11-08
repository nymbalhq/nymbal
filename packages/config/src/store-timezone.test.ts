import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { storeSchema } from './schema.js'

// `store.timezone` is read with Intl.DateTimeFormat, which throws on a zone it does not know; the schema refuses
// such a zone at startup instead, so the failure names the config rather than surfacing on first use.

const store = (timezone: string) => ({ name: 'Test', currency: 'GBP', locale: 'en-GB', timezone })

const MESSAGE = 'store.timezone must be an IANA time zone such as Europe/London'

describe('store.timezone', () => {
  it.each(['London', 'UTC+1', 'GMT+1', 'Europe/Londinium', 'not a zone'])(
    'refuses %s with a message naming an IANA example',
    (timezone) => {
      const result = storeSchema.safeParse(store(timezone))
      expect(result.success).toBe(false)
      expect(result.error?.issues).toEqual([
        expect.objectContaining({ path: ['timezone'], message: MESSAGE }),
      ])
    },
  )

  it.each(['Europe/London', 'UTC', 'Asia/Kolkata', 'America/St_Johns'])(
    'keeps %s as given',
    (timezone) => {
      expect(storeSchema.parse(store(timezone)).timezone).toBe(timezone)
    },
  )

  it('accepts exactly the zones Intl.DateTimeFormat accepts', () => {
    const zones = Intl.supportedValuesOf('timeZone')
    fc.assert(
      fc.property(fc.oneof(fc.constantFrom(...zones), fc.string({ minLength: 1 })), (timezone) => {
        let intlAccepts = true
        try {
          new Intl.DateTimeFormat(undefined, { timeZone: timezone })
        } catch {
          intlAccepts = false
        }
        expect(storeSchema.safeParse(store(timezone)).success).toBe(intlAccepts)
      }),
    )
  })
})
