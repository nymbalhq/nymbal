import type { Matrix, MatrixAdapter } from '../../packages/cli/src/upgrade/matrix'
import type { EntryStatus } from './status'

/** `previous` with the row for this night's stack version replaced by what the night found; every other row is kept. */
export function mergeMatrix(
  previous: Matrix | undefined,
  stack: { version: string; packages: Record<string, string> },
  adapters: Record<string, { version: string | null; status: EntryStatus; line: string }>,
  now: Date,
): Matrix {
  const row: Record<string, MatrixAdapter> = {}
  for (const [name, { version, status, line }] of Object.entries(adapters)) {
    row[name] = { version, status, ...(line === '' ? {} : { line }) }
  }
  return {
    schema: 1,
    generatedAt: now.toISOString(),
    stacks: {
      ...previous?.stacks,
      [stack.version]: { packages: stack.packages, adapters: row },
    },
  }
}
