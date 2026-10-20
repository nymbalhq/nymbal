import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { InMemoryDocumentStore } from '../../src/document-store/in-memory.js'
import { InProcessEventBus } from '../../src/event-bus/in-process.js'
import { createLogger } from '../../src/logger.js'
import { createLocalFsMediaStorage } from '../../src/media/index.js'
import { createPlatform } from '../../src/platform.js'
import { createKernel, kernelConfig, type Kernel } from '../support/kernel.js'

// Acceptance tests for P2-02 AC-4 (spec P2-02-primitives-are-protocols), the platform half: createPlatform takes the
// primitives as instances (decision 2) and holds the very ones it was given, media included; app.platform.media is a
// media storage, and app.capabilities().media is the configured provider with that instance's own capabilities(). The
// contract half is tests/contracts/media-storage.test.ts. Kills: a hard-coded media report (P2-01's
// LOCAL_FS_MEDIA_CAPABILITIES), and a platform that builds its own primitives or holds no media instance.

const logger = createLogger({ pretty: false, level: 'error' })
const dirs: string[] = []
const kernels: Kernel[] = []
afterAll(async () => {
  for (const k of kernels.splice(0)) await k.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'p2-02-media-slot-'))
  dirs.push(dir)
  return dir
}

describe('P2-02 AC-4: the platform holds the primitives it is given', () => {
  it('AC-4: createPlatform({ documentStore, eventBus, media }) exposes those very instances', async () => {
    const dir = scratch()
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const eventBus = new InProcessEventBus({ logger })
    const media = createLocalFsMediaStorage({ root: join(dir, 'media') })

    const platform = createPlatform(kernelConfig('sqlite'), {
      sqlitePath: join(dir, 'store.sqlite'),
      logger,
      documentStore,
      eventBus,
      media,
    })

    try {
      expect(platform.documentStore).toBe(documentStore)
      expect(platform.eventBus).toBe(eventBus)
      expect(platform.media).toBe(media)
    } finally {
      await platform.close()
    }
  })
})

describe('P2-02 AC-4: the media report is read from the instance', () => {
  it('AC-4: app.platform.media is a media storage; app.capabilities().media is the configured provider with its capabilities(), and follows the instance when its answer changes', async () => {
    const k = await createKernel({ dialect: 'sqlite' })
    kernels.push(k)
    const media = k.app.platform.media

    expect(typeof media?.put).toBe('function')
    const report = k.app.capabilities().media
    expect(report.provider).toBe(k.config.infrastructure.media)
    expect(report.capabilities).toEqual(media.capabilities())

    vi.spyOn(media, 'capabilities').mockReturnValue(['p2-02-probe'])
    expect(k.app.capabilities().media.capabilities).toEqual(media.capabilities())
    expect(k.app.capabilities().media.capabilities).toEqual(['p2-02-probe'])
  })
})
