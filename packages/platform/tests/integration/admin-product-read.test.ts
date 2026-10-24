import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSession, type AdminSession } from '../support/audit.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, type Kernel } from '../support/kernel.js'
import { asJson } from '../support/history.js'

// AC-6 on SQLite: `GET /api/admin/products/:idOrSlug` answers the live ProductSnapshot, by id and by slug alike; 404
// `not_found` for neither; 401 without a session. The admin's product edit page reads it with the slug.

let k: Kernel
let served: ServedKernel
let admin: AdminSession

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  served = await serveKernel(k)
  admin = await adminSession(k, served.baseUrl)
}, 60_000)

afterAll(async () => {
  await served?.stop()
})

describe('AC-6: the admin product GET', () => {
  it('AC-6: by id and by slug it answers the live ProductSnapshot, the same for both', async () => {
    const tag = randomUUID().slice(0, 8)
    const created = await admin.send<{ id: string; slug: string }>('POST', '/api/admin/products', {
      slug: `history-ac6-${tag}`,
      name: `Readable ${tag}`,
      description: 'Read back by the edit page.',
      shortDescription: 'Short',
      status: 'draft',
      variants: [
        { sku: `AC6-A-${tag}`, name: 'Small', priceMinor: 1100, stock: 4, options: [] },
        { sku: `AC6-B-${tag}`, name: 'Large', priceMinor: 1300, stock: 0, options: [] },
      ],
    })
    expect(created.status).toBe(201)
    const { id, slug } = created.body.data!
    const adjusted = await admin.send(
      'POST',
      `/api/admin/inventory/${(await k.services.product.getById(id)).variants[0]!.id}/adjust`,
      { delta: 2, reason: 'manual' },
    )
    expect(adjusted.status).toBe(200)

    const byId = await admin.send('GET', `/api/admin/products/${id}`)
    const bySlug = await admin.send('GET', `/api/admin/products/${slug}`)
    expect(byId.status, JSON.stringify(byId.body)).toBe(200)
    expect(byId.body.data, 'by id: the live snapshot').toEqual(
      asJson(await k.services.product.getById(id)),
    )
    expect(bySlug.status, JSON.stringify(bySlug.body)).toBe(byId.status)
    expect(bySlug.body.data, 'by slug: the same snapshot as by id').toEqual(byId.body.data)
  })

  it('AC-6: an unknown id or slug answers 404 not_found; no session answers 401', async () => {
    for (const unknown of [randomUUID(), `no-such-product-${randomUUID().slice(0, 8)}`]) {
      const res = await admin.send('GET', `/api/admin/products/${unknown}`)
      expect([res.status, res.body.error?.code], unknown).toEqual([404, 'not_found'])
    }
    const tag = randomUUID().slice(0, 8)
    const created = await admin.send<{ id: string }>('POST', '/api/admin/products', {
      slug: `history-ac6-anon-${tag}`,
      name: 'Private',
      description: '',
      status: 'active',
      variants: [{ sku: `AC6-${tag}`, name: 'Default', priceMinor: 500, stock: 1, options: [] }],
    })
    expect(created.status).toBe(201)
    const anonymous = await fetch(
      new URL(`/api/admin/products/${created.body.data!.id}`, served.baseUrl),
    )
    expect(anonymous.status).toBe(401)
  })
})
