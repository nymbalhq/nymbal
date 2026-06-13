import { createServer } from 'node:net'

/**
 * Resolve a usable storefront port.
 *
 * The headline `nymbal dev` flow must not hard-fail when the preferred port is
 * already taken (a developer commonly has another project on 4321/3000). We
 * probe the preferred port first and, if it is busy, increment until we find a
 * free one — exactly how the underlying dev servers (Astro, Next.js) behave on
 * their own, but here we resolve the port *before* spawning so we can tell the
 * storefront which port to bind and tell the user where to open the browser.
 */
export async function isPortFree(port: number, host?: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = createServer()
    server.once('error', (err: NodeJS.ErrnoException) => {
      // EADDRINUSE / EACCES → not usable. Any other error → treat as not free
      // rather than silently swallowing it; the caller will skip this port.
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') {
        // eslint-disable-next-line no-console
        console.error(`[dev] unexpected error probing port ${port}:`, err.message)
      }
      resolve(false)
    })
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    // Bind across all interfaces (no explicit host) so a port already held on
    // IPv6 (e.g. another dev server on [::1]) is correctly seen as busy. A
    // 127.0.0.1-only probe would miss an IPv6 listener and wrongly report free,
    // then the framework — which binds dual-stack — would fail on that port.
    if (host) {
      server.listen(port, host)
    } else {
      server.listen(port)
    }
  })
}

/**
 * Find a free port starting at `preferred`, scanning upward up to `maxAttempts`
 * times. Throws an actionable error if no port in the range is free.
 */
export async function findFreePort(
  preferred: number,
  maxAttempts = 20,
  host?: string,
): Promise<number> {
  if (!Number.isInteger(preferred) || preferred < 1 || preferred > 65535) {
    throw new Error(
      `Invalid storefront port "${preferred}". Set a valid port (1–65535) via --storefront-port or NYMBAL_STOREFRONT_PORT.`,
    )
  }
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = preferred + i
    if (candidate > 65535) break
    if (await isPortFree(candidate, host)) {
      return candidate
    }
  }
  throw new Error(
    `No free storefront port found in range ${preferred}–${Math.min(preferred + maxAttempts - 1, 65535)}. ` +
      `Free a port in that range or pass an explicit free port via --storefront-port.`,
  )
}
