import { createServer } from 'node:net'
import { createHttpServer } from '../../../http/dist/index.js'
import type { Kernel } from './kernel.js'

// P1-04 support: a kernel built from `src/` (createKernel) served over HTTP, so a route-level test and the sentinel
// runner see the working tree without a build. The shape of proof-kit's startTestStore, minus the dist kernel.

const HOST = '127.0.0.1'

export interface ServedKernel {
  kernel: Kernel
  baseUrl: string
  /** Stops the server, then the kernel. */
  stop(): Promise<void>
}

// The config schema rejects port 0, so the port is found by binding one and releasing it.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, HOST, () => {
      const address = probe.address()
      probe.close(() =>
        typeof address === 'object' && address !== null
          ? resolve(address.port)
          : reject(new Error('freePort: no address')),
      )
    })
  })
}

function addressInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE'
}

export async function serveKernel(kernel: Kernel): Promise<ServedKernel> {
  let port = await freePort()
  for (let attempt = 0; ; attempt += 1) {
    const http = createHttpServer({
      config: { ...kernel.config, http: { ...kernel.config.http, port, host: HOST } },
      logger: kernel.logger,
      documentStore: kernel.documentStore,
      version: '0.0.0',
    })
    await kernel.app.attachHttp(http.adapter)
    try {
      await http.start()
    } catch (error) {
      // Another worker can take the port between the probe and the bind: one retry on a fresh port.
      if (attempt > 0 || !addressInUse(error)) throw error
      port = await freePort()
      continue
    }
    return {
      kernel,
      baseUrl: `http://${HOST}:${port}`,
      async stop() {
        try {
          await http.stop()
        } finally {
          await kernel.close()
        }
      },
    }
  }
}
