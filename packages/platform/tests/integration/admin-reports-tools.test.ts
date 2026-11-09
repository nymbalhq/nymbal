import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@nymbalhq/types'
import { assistantTools as offeredBy } from '../../src/assistant/loop.js'
import { assistantStore, type AssistantStore } from '../support/assistant.js'
import { adminClient } from '../support/money.js'
import { toolSurface } from '../support/mcp.js'
import { clearReports, deliver, events, noonOf, seedOrder, addDays, storeDay } from '../support/report-rollups.js'

// The admin report as the agents reach it: offered as a read to the assistant and MCP, under every customerData
// setting since it is not marked personal, and answering what the route answers.

let store: AssistantStore

beforeAll(async () => {
  store = await assistantStore({})
}, 60_000)

afterAll(async () => {
  await store?.close()
})

describe('AC-27: admin_reports_get reaches the admin’s agents', () => {
  it('AC-27: it is offered over MCP and the assistant, also under customerData: false, and its result equals the route’s', async () => {
    await clearReports(store.kernel)
    const order = await seedOrder(store.kernel)
    await deliver(
      store.kernel,
      events.captured(order, 4_200, noonOf(addDays(storeDay(new Date()), -2))),
    )

    const tools = toolSurface(store.kernel.app)
    const listed = (await tools.list(store.caller)) as ToolDefinition[]
    expect(listed.map((t) => t.name)).toContain('admin_reports_get')
    expect(offeredBy(listed, {}).map((t) => t.name)).toContain('admin_reports_get')
    expect(offeredBy(listed, { customerData: false }).map((t) => t.name)).toContain(
      'admin_reports_get',
    )

    const result = await tools.call('admin_reports_get', {}, store.caller)
    const admin = await adminClient(store.kernel, store.baseUrl)
    const route = await admin.call<Record<string, unknown>>('GET', '/api/admin/reports')

    expect(result.isError).not.toBe(true)
    const text = result.content.map((c) => c.text).join('')
    expect(JSON.parse(text)).toEqual(route.body.data)
    expect(text.length).toBeLessThan(16_000)
  })
})
