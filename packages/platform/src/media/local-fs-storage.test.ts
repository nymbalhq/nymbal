import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { ValidationError } from '@nymbalhq/types'
import { createLocalFsMediaStorage } from './local-fs-storage.js'

// Local media storage writes a key's file under its root or refuses the key with `media.key_outside_root`: a key
// whose resolved path leaves the root, an absolute key, and a key holding `\` or NUL never write. The root sits eight
// directories deep in a sandbox, so a key that escapes it lands in the sandbox, where the test can see it.

const DEPTH = 8
const sandboxes: string[] = []

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function sandbox(): { outer: string; root: string } {
  const outer = mkdtempSync(join(tmpdir(), 'local-media-'))
  sandboxes.push(outer)
  const root = join(outer, ...Array.from({ length: DEPTH }, (_, i) => `l${i}`), 'root')
  mkdirSync(root, { recursive: true })
  return { outer, root }
}

/** Every file under `dir`, as an absolute path. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
}

/** Whether a key may be written: relative, no backslash or NUL, and resolving to a path strictly under the root. */
function staysInside(root: string, key: string): boolean {
  if (key.includes('\\') || key.includes('\0') || isAbsolute(key)) return false
  return resolve(root, key).startsWith(resolve(root) + sep)
}

const segment = fc.constantFrom('..', '.', 'a', 'b', 'c')
const key = fc
  .record({
    absolute: fc.boolean(),
    segments: fc.array(segment, { maxLength: DEPTH - 2 }),
    file: fc.constantFrom('x.jpg', 'y.png', 'a\\..\\..\\z.jpg', 'n\0.jpg'),
  })
  .map(({ absolute, segments, file }) => `${absolute ? '/' : ''}${[...segments, file].join('/')}`)

async function outcome(
  root: string,
  k: string,
  body: Uint8Array,
): Promise<{ wrote: string } | { refused: string }> {
  const storage = createLocalFsMediaStorage({ root })
  try {
    const { url } = await storage.put(k, body, 'image/jpeg')
    return { wrote: url }
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error
    return { refused: error.code }
  }
}

describe('AC-13: local media keys stay under the root', () => {
  it('AC-13: products/a/b.jpg writes under the root and answers /imported-media/products/a/b.jpg; over generated keys, put writes under the root exactly when the key stays inside it, refuses every other key with media.key_outside_root, and leaves no file outside the root', async () => {
    const plain = sandbox()
    const image = new TextEncoder().encode('an image')
    expect(await outcome(plain.root, 'products/a/b.jpg', image)).toEqual({
      wrote: '/imported-media/products/a/b.jpg',
    })
    expect(readFileSync(join(plain.root, 'products', 'a', 'b.jpg'))).toEqual(Buffer.from(image))

    await fc.assert(
      fc.asyncProperty(key, async (k) => {
        const { outer, root } = sandbox()
        const text = `bytes of ${JSON.stringify(k)}`
        const inside = staysInside(root, k)

        const answer = await outcome(root, k, new TextEncoder().encode(text)).catch(
          (error: unknown) => ({ threw: String(error) }),
        )
        const outside = filesUnder(outer).filter((f) => relative(root, f).startsWith('..'))
        const written =
          inside && existsSync(resolve(root, k)) ? readFileSync(resolve(root, k), 'utf8') : null

        expect(outside, JSON.stringify(k)).toEqual([])
        expect(
          { answer: 'wrote' in answer ? 'wrote' : answer, written },
          JSON.stringify(k),
        ).toEqual(
          inside
            ? { answer: 'wrote', written: text }
            : { answer: { refused: 'media.key_outside_root' }, written: null },
        )
      }),
      { numRuns: 200 },
    )
  })
})
