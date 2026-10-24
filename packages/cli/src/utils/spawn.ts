import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

export interface RunOptions extends SpawnOptions {
  name?: string
}

export function run(
  command: string,
  args: string[],
  options: RunOptions = {},
): { child: ChildProcess; done: Promise<number> } {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: false,
    ...options,
  })
  const done = new Promise<number>((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 0))
  })
  return { child, done }
}

export async function runOrFail(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<void> {
  const { done } = run(command, args, options)
  const code = await done
  if (code !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with code ${code}`)
  }
}
