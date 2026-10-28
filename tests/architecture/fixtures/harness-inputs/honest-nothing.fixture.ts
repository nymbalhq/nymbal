// Reads: nothing
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Declares nothing: it reads only a file it wrote outside the checkout, and runs git only there.

export function roundTrip(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'reads-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  const file = join(dir, 'x.txt')
  writeFileSync(file, text)
  return readFileSync(file, 'utf8')
}
