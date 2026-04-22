import { spawn } from 'node:child_process';
export function run(command, args, options = {}) {
    const child = spawn(command, args, {
        stdio: 'inherit',
        shell: false,
        ...options,
    });
    const done = new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', (code) => resolve(code ?? 0));
    });
    return { child, done };
}
export async function runOrFail(command, args, options = {}) {
    const { done } = run(command, args, options);
    const code = await done;
    if (code !== 0) {
        throw new Error(`${command} ${args.join(' ')} exited with code ${code}`);
    }
}
//# sourceMappingURL=spawn.js.map