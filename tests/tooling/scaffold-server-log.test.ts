// Reads: scripts/scaffold-clean.sh
import { execFile } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { REPO } from './scratch-gate'

// The clean-machine proof serves the scaffolded store with `nymbal dev` and writes the server's output to a log. A
// red is read from that log, so it outlives the run under reports/ instead of going with the run's temp directory.
// The script runs here from a scratch root, with the registry and `npx` stood in for: the scaffold is a bare config
// and the server prints one line and exits, so the run ends red at the server's exit. The script puts the directory
// of the `node` it finds first on PATH, so `node` is linked into the stand-ins' directory to keep `npx` theirs.

const exec = promisify(execFile)
const created: string[] = []
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const SERVER_LINE = 'the server says why it stopped'

const REGISTRY = `registry_free_port() { node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})'; }
registry_cleanup() { :; }
registry_start() { registry=http://127.0.0.1:1; }
registry_publish() { snapshot=0.0.0-test; }
`

const NPX = `#!/bin/sh
case "$*" in
  *create-nymbal-app*) mkdir -p shop && printf 'export default defineConfig({\\n})\\n' >shop/nymbal.config.ts ;;
  *"nymbal dev"*) echo "${SERVER_LINE}"; exit 3 ;;
  *) exit 64 ;;
esac
`

describe('the clean-machine proof keeps its server log', () => {
  it('after a run the server ended, the whole log is in reports/, where the run said it was', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-scaffold-log-')))
    created.push(root)
    mkdirSync(join(root, 'scripts'))
    mkdirSync(join(root, 'bin'))
    copyFileSync(join(REPO, 'scripts/scaffold-clean.sh'), join(root, 'scripts/scaffold-clean.sh'))
    writeFileSync(join(root, 'scripts/local-registry.sh'), REGISTRY)
    writeFileSync(join(root, 'bin/npx'), NPX)
    chmodSync(join(root, 'bin/npx'), 0o755)
    try {
      linkSync(process.execPath, join(root, 'bin/node'))
    } catch {
      copyFileSync(process.execPath, join(root, 'bin/node'))
    }
    const run = await exec('bash', [join(root, 'scripts/scaffold-clean.sh'), 'astro'], {
      cwd: root,
      env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` },
    }).then(
      () => ({ code: 0, stderr: '' }),
      (error: { code: number; stderr: string }) => error,
    )
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('scaffold-clean: nymbal dev exited')
    const log = readFileSync(join(root, 'reports/scaffold-clean-astro-dev.log'), 'utf8')
    expect(log.trim()).toBe(SERVER_LINE)
    // What the run printed of the log is the log it kept.
    expect(run.stderr).toContain(log.trim())
  })
})
