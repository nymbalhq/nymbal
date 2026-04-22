import { type HttpAdapter } from '@nymbal/types'
import type { CustomerService } from '../services/customer-service.js'
import { ok, fail, renderError } from './envelope.js'
import { requireAuth } from './role-middleware.js'

interface AddressBody {
  id?: string
  firstName: string
  lastName: string
  addressLine1: string
  addressLine2?: string
  city: string
  region: string
  postalCode: string
  country: string
  phone?: string
  isDefaultBilling?: boolean
  isDefaultShipping?: boolean
  company?: string
}

export function registerCustomerRoutes(adapter: HttpAdapter, customers: CustomerService): void {
  adapter.registerRoute(
    'GET',
    '/api/customers/me',
    requireAuth(async (ctx) => {
      try {
        return ok(await customers.getProfile(ctx.auth!.userId!))
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  adapter.registerRoute(
    'PATCH',
    '/api/customers/me',
    requireAuth(async (ctx) => {
      try {
        const patch = ctx.body as Record<string, unknown>
        const profile = await customers.updateProfile(ctx.auth!.userId!, {
          ...(typeof patch.firstName === 'string' && { firstName: patch.firstName }),
          ...(typeof patch.lastName === 'string' && { lastName: patch.lastName }),
          ...(typeof patch.phone === 'string' && { phone: patch.phone }),
        })
        return ok(profile)
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  adapter.registerRoute(
    'GET',
    '/api/customers/me/addresses',
    requireAuth(async (ctx) => {
      try {
        return ok(await customers.listAddresses(ctx.auth!.userId!))
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  adapter.registerRoute(
    'POST',
    '/api/customers/me/addresses',
    requireAuth(async (ctx) => {
      try {
        const body = ctx.body as AddressBody
        if (!body || !body.addressLine1) return fail('address.invalid', 'address invalid', 400)
        const addr = await customers.addAddress(ctx.auth!.userId!, {
          firstName: body.firstName,
          lastName: body.lastName,
          addressLine1: body.addressLine1,
          city: body.city,
          region: body.region,
          postalCode: body.postalCode,
          country: body.country,
          isDefaultBilling: body.isDefaultBilling ?? false,
          isDefaultShipping: body.isDefaultShipping ?? false,
          ...(body.addressLine2 !== undefined && { addressLine2: body.addressLine2 }),
          ...(body.company !== undefined && { company: body.company }),
          ...(body.phone !== undefined && { phone: body.phone }),
        })
        return ok(addr, undefined, 201)
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  adapter.registerRoute(
    'DELETE',
    '/api/customers/me/addresses/:id',
    requireAuth(async (ctx) => {
      try {
        const id = ctx.params.id
        if (!id) return fail('address.invalid', 'id required', 400)
        await customers.deleteAddress(ctx.auth!.userId!, id)
        return ok({ ok: true })
      } catch (err) {
        return renderError(err)
      }
    }),
  )
}
