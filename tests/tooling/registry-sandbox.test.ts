// Reads: scripts/registry/**, package.json, .node-version
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

// The registry run's sandbox, seen through a `docker` on PATH that records each call and does nothing: every
// container it starts runs the Node the repo pins, and is handed no environment. Needs the workspace CLI built.

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const NODE_VERSION = readFileSync(join(REPO, '.node-version'), 'utf8').trim()

const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
  for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key]
  delete env['NODE_OPTIONS']
  delete env['NODE_ENV']
  return env
}

/** A scratch dir with a `docker` on PATH running `script` after recording its argv, a one-entry manifest and a history. */
function fakeDocker(script: string[], history: string) {
  const dir = mkdtempSync(join(tmpdir(), 'registry-sandbox-'))
  scratch.push(dir)
  const bin = join(dir, 'bin')
  const calls = join(dir, 'calls')
  mkdirSync(bin)
  mkdirSync(calls)
  mkdirSync(join(dir, 'work'))
  writeFileSync(
    join(bin, 'docker'),
    [
      '#!/usr/bin/env bash',
      `n=$(ls "${calls}" | wc -l | tr -d ' ')`,
      `printf '%s\\n' "$@" >"${calls}/$n"`,
      ...script,
      '',
    ].join('\n'),
  )
  chmodSync(join(bin, 'docker'), 0o755)
  const manifest = join(dir, 'adapters.json')
  writeFileSync(
    manifest,
    JSON.stringify({
      adapters: [
        {
          package: '@acme/nymbal-search',
          slot: 'search',
          provider: 'acme',
          tier: 'community',
          maintainer: 'https://github.com/acme',
          source: { npm: '^1.0.0' },
        },
      ],
    }),
  )
  const historyFile = join(dir, 'history.json')
  writeFileSync(historyFile, history)

  const run = spawnSync(
    'pnpm',
    [
      '--silent',
      'registry',
      '--manifest',
      manifest,
      '--history',
      historyFile,
      '--out',
      join(dir, 'site'),
      '--now',
      '2026-10-31T03:00:00.000Z',
      '--entry-timeout',
      '10',
      '--work',
      join(dir, 'work'),
    ],
    {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...cleanEnv(), PATH: `${bin}:${process.env['PATH'] ?? ''}` },
      timeout: 50_000,
    },
  )
  const runs = readdirSync(calls)
    .sort((a, b) => Number(a) - Number(b))
    .map((f) => readFileSync(join(calls, f), 'utf8').split('\n').slice(0, -1))
    .filter((argv) => argv[0] === 'run')
  return { run, out: `${run.stdout ?? ''}${run.stderr ?? ''}`, runs, historyFile, dir }
}

describe('AC-6: the sandbox image is the pinned Node', () => {
  it('AC-6: every container the registry run starts is node:<.node-version>-bookworm-slim, and none is passed an environment', () => {
    const { run, out, runs } = fakeDocker(['exit 0'], '{}\n')

    expect(run.status, out).toBe(0)
    expect(runs.length, out).toBeGreaterThanOrEqual(1)
    expect(runs.map((argv) => argv.filter((a) => /^node:/.test(a)))).toEqual(
      runs.map(() => [`node:${NODE_VERSION}-bookworm-slim`]),
    )
    // Docker's own options come before the image; what follows is the container's command.
    const options = runs.map((argv) =>
      argv.slice(
        0,
        argv.findIndex((a) => /^node:/.test(a)),
      ),
    )
    expect(options.flatMap((o) => o.filter((a) => /^(-e|--env|--env-file)(=|$)/.test(a)))).toEqual(
      [],
    )
  })
})

describe('docker failing on its own', () => {
  it('a docker run that exits 125 fails the run with one line and charges no entry a failing night', () => {
    const history = `${JSON.stringify(
      {
        '@acme/nymbal-search': {
          status: 'failing',
          failingSince: '2026-10-25T03:00:00.000Z',
          lastRun: '2026-10-30T03:00:00.000Z',
          line: 'not certified @acme/nymbal-search (search): 1 of 30 cases failed',
        },
      },
      null,
      2,
    )}\n`
    const { run, out, runs, historyFile, dir } = fakeDocker(
      [
        'if [ "$1" = run ]; then',
        "  echo 'docker: Error response from daemon: failed to create task' >&2",
        '  exit 125',
        'fi',
        'exit 0',
      ],
      history,
    )

    expect(run.status, out).toBe(1)
    expect(runs.length, out).toBe(1)
    expect(run.stderr.trim().split('\n'), out).toEqual([
      'docker run exited 125: docker: Error response from daemon: failed to create task',
    ])
    expect(readFileSync(historyFile, 'utf8')).toBe(history)
    expect(readdirSync(dir)).not.toContain('site')
  })
})
