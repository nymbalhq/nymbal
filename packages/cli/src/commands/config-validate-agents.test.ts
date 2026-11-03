import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nymbalConfigSchema } from '@nymbalhq/config'
import repoConfig from '../../../../nymbal.config.js'
import { cliEnv, runCli } from '../../../../tests/support/doctor.js'

// AC-12: `nymbal config:validate` on a project whose agents.mcp.writes is not a value the store takes. Spawns the
// built CLI (`pnpm build` first).

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(agents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'nymbal-config-agents-'))
  dirs.push(dir)
  writeFileSync(
    join(dir, 'nymbal.config.ts'),
    `export default ${JSON.stringify({ ...repoConfig, agents }, null, 2)}\n`,
  )
  return dir
}

/** The message the config schema itself gives for agents.mcp.writes set to `writes`. */
function schemaMessage(writes: string): string {
  const result = nymbalConfigSchema.safeParse({ ...repoConfig, agents: { mcp: { writes } } })
  const issue = result.success
    ? undefined
    : result.error.issues.find((i) => i.path.join('.') === 'agents.mcp.writes')
  if (issue === undefined) throw new Error(`the config schema accepts agents.mcp.writes ${writes}`)
  return issue.message
}

describe('AC-12: config:validate reports agents.mcp.writes', () => {
  it("AC-12: writes 'always' fails config:validate naming agents.mcp.writes, proposal and apply, where writes 'apply' passes", async () => {
    const refused = await runCli(['config:validate'], {
      cwd: project({ mcp: { writes: 'always' } }),
      env: cliEnv(),
    })
    const accepted = await runCli(['config:validate'], {
      cwd: project({ mcp: { writes: 'apply' } }),
      env: cliEnv(),
    })
    const reported = refused.out.split('\n').filter((line) => line.includes('agents.mcp.writes'))

    expect([refused.code, accepted.code], refused.out + accepted.out).toEqual([1, 0])
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain(schemaMessage('always'))
    expect(reported[0]).toMatch(/proposal/)
    expect(reported[0]).toMatch(/apply/)
  }, 60_000)
})
