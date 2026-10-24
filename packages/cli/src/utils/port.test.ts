import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { findFreePort, isPortFree } from './port.js'

/**
 * The headline `nymbal dev` flow must never hard-fail when the preferred
 * storefront port is taken. These tests hold a real port and assert the probe
 * detects it as busy and the finder falls through to the next free port —
 * exactly the situation where 4321 is held by an unrelated project.
 */
describe('port selection', () => {
  const servers: Server[] = []

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => resolve())
          }),
      ),
    )
  })

  function hold(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = createServer()
      servers.push(s)
      s.once('error', reject)
      s.listen(port, () => resolve())
    })
  }

  async function findOpenPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const s = createServer()
      s.once('error', reject)
      s.listen(0, () => {
        const addr = s.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        s.close(() => resolve(port))
      })
    })
  }

  it('reports a held port as not free and an open port as free', async () => {
    const held = await findOpenPort()
    await hold(held)
    expect(await isPortFree(held)).toBe(false)

    const open = await findOpenPort()
    expect(await isPortFree(open)).toBe(true)
  })

  it('falls through to the next free port when the preferred port is busy', async () => {
    const preferred = await findOpenPort()
    await hold(preferred)
    const resolved = await findFreePort(preferred, 20)
    expect(resolved).toBeGreaterThan(preferred)
    expect(await isPortFree(resolved)).toBe(true)
  })

  it('returns the preferred port unchanged when it is free', async () => {
    const preferred = await findOpenPort()
    const resolved = await findFreePort(preferred, 20)
    expect(resolved).toBe(preferred)
  })

  it('throws an actionable error for an out-of-range port', async () => {
    await expect(findFreePort(0)).rejects.toThrow(/Invalid storefront port/)
    await expect(findFreePort(70000)).rejects.toThrow(/Invalid storefront port/)
  })

  it('throws when no port in the scan range is free', async () => {
    const base = await findOpenPort()
    // Hold base and the next two, then only allow a 3-port scan window.
    await hold(base)
    await hold(base + 1).catch(() => {})
    await hold(base + 2).catch(() => {})
    await expect(findFreePort(base, 3)).rejects.toThrow(/No free storefront port found/)
  })
})
