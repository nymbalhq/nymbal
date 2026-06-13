import { describe, it, expect, vi } from 'vitest'
import { registerCustomerRoutes } from './customers.js'
import type { HttpAdapter, RouteHandler, Customer, CustomerAddress, RequestContext } from '@nymbal/types'
import type { CustomerService } from '../services/customer-service.js'

function makeAdapter() {
  const routes = new Map<string, RouteHandler>()
  const adapter: HttpAdapter = {
    registerRoute(method, path, handler) {
      routes.set(`${method}:${path}`, handler)
    },
    registerStreamRoute() {},
    registerMiddleware() {},
    setDefaultHeaders() {},
    async start() {},
    async stop() {},
  }

  async function invoke(
    method: string,
    path: string,
    options: {
      body?: unknown
      params?: Record<string, string>
      auth?: RequestContext['auth']
    } = {},
  ) {
    const handler = routes.get(`${method}:${path}`)
    if (!handler) throw new Error(`No route registered for ${method} ${path}`)
    return handler({
      method: method as 'GET',
      path,
      url: `http://localhost${path}`,
      params: options.params ?? {},
      query: {},
      body: options.body ?? null,
      headers: {},
      cookies: {},
      ...(options.auth !== undefined && { auth: options.auth }),
      requestId: 'test-req',
      correlationId: 'test-corr',
      logger: {
        trace() {}, debug() {}, info() {}, warn() {}, error() {},
        child() { return this },
      },
      ip: '127.0.0.1',
    })
  }

  return { adapter, invoke }
}

const testCustomer: Customer = {
  id: 'cust-1',
  email: 'test@example.com',
  firstName: 'Jane',
  lastName: 'Doe',
  phone: '',
  addresses: [],
  orderCount: 5,
  totalSpentMinor: 10000,
  metadata: {},
  requiresPasswordReset: false,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
}

const testAddress: CustomerAddress = {
  id: 'addr-1',
  firstName: 'Jane',
  lastName: 'Doe',
  addressLine1: '1 Test Street',
  city: 'London',
  region: 'England',
  postalCode: 'SW1A 1AA',
  country: 'GB',
  isDefaultBilling: true,
  isDefaultShipping: true,
}

function makeCustomerService(overrides?: Partial<CustomerService>): CustomerService {
  return {
    getProfile: vi.fn().mockResolvedValue(testCustomer),
    updateProfile: vi.fn().mockResolvedValue({ ...testCustomer, firstName: 'Updated' }),
    listAddresses: vi.fn().mockResolvedValue([testAddress]),
    addAddress: vi.fn().mockResolvedValue({ ...testAddress, id: 'addr-new' }),
    deleteAddress: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

const authenticatedUser: RequestContext['auth'] = {
  userId: 'cust-1',
  roles: ['customer'],
}

describe('GET /api/customers/me', () => {
  it('returns 401 when unauthenticated', async () => {
    const { adapter, invoke } = makeAdapter()
    registerCustomerRoutes(adapter, makeCustomerService())

    const resp = await invoke('GET', '/api/customers/me')
    expect(resp.status).toBe(401)
  })

  it('returns customer profile when authenticated', async () => {
    const service = makeCustomerService()
    const { adapter, invoke } = makeAdapter()
    registerCustomerRoutes(adapter, service)

    const resp = await invoke('GET', '/api/customers/me', { auth: authenticatedUser })
    expect(resp.status).toBe(200)
    const body = resp.body as { data: Customer }
    expect(body.data.id).toBe('cust-1')
    expect(body.data.email).toBe('test@example.com')
    expect(body.data.firstName).toBe('Jane')
    expect(body.data.lastName).toBe('Doe')
    expect(service.getProfile).toHaveBeenCalledWith('cust-1')
  })

  it('response contains all Customer fields', async () => {
    const { adapter, invoke } = makeAdapter()
    registerCustomerRoutes(adapter, makeCustomerService())

    const resp = await invoke('GET', '/api/customers/me', { auth: authenticatedUser })
    const body = resp.body as { data: Customer }
    expect(body.data).toMatchObject({
      id: 'cust-1',
      email: 'test@example.com',
      firstName: 'Jane',
      lastName: 'Doe',
      phone: '',
      orderCount: 5,
      totalSpentMinor: 10000,
    })
  })

  it('response is wrapped in { data } envelope', async () => {
    const { adapter, invoke } = makeAdapter()
    registerCustomerRoutes(adapter, makeCustomerService())

    const resp = await invoke('GET', '/api/customers/me', { auth: authenticatedUser })
    const body = resp.body as Record<string, unknown>
    expect('data' in body).toBe(true)
    expect('error' in body).toBe(false)
  })
})

describe('PATCH /api/customers/me', () => {
  it('returns 401 when unauthenticated', async () => {
    const { adapter, invoke } = makeAdapter()
    registerCustomerRoutes(adapter, makeCustomerService())

    const resp = await invoke('PATCH', '/api/customers/me', { body: { firstName: 'Updated' } })
    expect(resp.status).toBe(401)
  })

  it('updates customer profile and returns updated data', async () => {
    const service = makeCustomerService()
    const { adapter, invoke } = makeAdapter()
    registerCustomerRoutes(adapter, service)

    const resp = await invoke('PATCH', '/api/customers/me', {
      auth: authenticatedUser,
      body: { firstName: 'Updated' },
    })
    expect(resp.status).toBe(200)
    const body = resp.body as { data: Customer }
    expect(body.data.firstName).toBe('Updated')
    expect(service.updateProfile).toHaveBeenCalledWith(
      'cust-1',
      expect.objectContaining({ firstName: 'Updated' }),
    )
  })

  it('ignores non-string fields in patch body', async () => {
    const service = makeCustomerService()
    const { adapter, invoke } = makeAdapter()
    registerCustomerRoutes(adapter, service)

    await invoke('PATCH', '/api/customers/me', {
      auth: authenticatedUser,
      body: { firstName: 'Updated', someMaliciousField: { foo: 'bar' } },
    })
    const callArgs = vi.mocked(service.updateProfile).mock.calls[0]?.[1]
    expect(callArgs).not.toHaveProperty('someMaliciousField')
  })
})

describe('GET /api/customers/me/addresses', () => {
  it('returns 401 when unauthenticated', async () => {
    const { adapter, invoke } = makeAdapter()
    registerCustomerRoutes(adapter, makeCustomerService())

    const resp = await invoke('GET', '/api/customers/me/addresses')
    expect(resp.status).toBe(401)
  })

  it('returns customer addresses', async () => {
    const { adapter, invoke } = makeAdapter()
    registerCustomerRoutes(adapter, makeCustomerService())

    const resp = await invoke('GET', '/api/customers/me/addresses', { auth: authenticatedUser })
    expect(resp.status).toBe(200)
    const body = resp.body as { data: CustomerAddress[] }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.id).toBe('addr-1')
    expect(body.data[0]?.addressLine1).toBe('1 Test Street')
  })
})

describe('POST /api/customers/me/addresses', () => {
  it('returns 401 when unauthenticated', async () => {
    const { adapter, invoke } = makeAdapter()
    registerCustomerRoutes(adapter, makeCustomerService())

    const resp = await invoke('POST', '/api/customers/me/addresses', {
      body: testAddress,
    })
    expect(resp.status).toBe(401)
  })

  it('returns 400 when addressLine1 is missing', async () => {
    const { adapter, invoke } = makeAdapter()
    registerCustomerRoutes(adapter, makeCustomerService())

    const resp = await invoke('POST', '/api/customers/me/addresses', {
      auth: authenticatedUser,
      body: { firstName: 'Jane', lastName: 'Doe', city: 'London' },
    })
    expect(resp.status).toBe(400)
  })

  it('adds address and returns 201 with the new address', async () => {
    const service = makeCustomerService()
    const { adapter, invoke } = makeAdapter()
    registerCustomerRoutes(adapter, service)

    const resp = await invoke('POST', '/api/customers/me/addresses', {
      auth: authenticatedUser,
      body: {
        firstName: 'Jane',
        lastName: 'Doe',
        addressLine1: '2 New Street',
        city: 'Manchester',
        region: 'Greater Manchester',
        postalCode: 'M1 1AA',
        country: 'GB',
        isDefaultBilling: false,
        isDefaultShipping: true,
      },
    })
    expect(resp.status).toBe(201)
    const body = resp.body as { data: CustomerAddress }
    expect(body.data.id).toBe('addr-new')
    expect(service.addAddress).toHaveBeenCalledWith(
      'cust-1',
      expect.objectContaining({ addressLine1: '2 New Street' }),
    )
  })
})

describe('DELETE /api/customers/me/addresses/:id', () => {
  it('returns 401 when unauthenticated', async () => {
    const { adapter, invoke } = makeAdapter()
    registerCustomerRoutes(adapter, makeCustomerService())

    const resp = await invoke('DELETE', '/api/customers/me/addresses/:id', {
      params: { id: 'addr-1' },
    })
    expect(resp.status).toBe(401)
  })

  it('returns 400 when id is missing', async () => {
    const { adapter, invoke } = makeAdapter()
    registerCustomerRoutes(adapter, makeCustomerService())

    const resp = await invoke('DELETE', '/api/customers/me/addresses/:id', {
      auth: authenticatedUser,
      params: { id: '' },
    })
    expect(resp.status).toBe(400)
  })

  it('deletes address and returns ok', async () => {
    const service = makeCustomerService()
    const { adapter, invoke } = makeAdapter()
    registerCustomerRoutes(adapter, service)

    const resp = await invoke('DELETE', '/api/customers/me/addresses/:id', {
      auth: authenticatedUser,
      params: { id: 'addr-1' },
    })
    expect(resp.status).toBe(200)
    const body = resp.body as { data: { ok: boolean } }
    expect(body.data.ok).toBe(true)
    expect(service.deleteAddress).toHaveBeenCalledWith('cust-1', 'addr-1')
  })
})
