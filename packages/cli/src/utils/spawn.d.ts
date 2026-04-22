import { type ChildProcess, type SpawnOptions } from 'node:child_process';
export interface RunOptions extends SpawnOptions {
    name?: string;
}
export declare function run(command: string, args: string[], options?: RunOptions): {
    child: ChildProcess;
    done: Promise<number>;
};
export declare function runOrFail(command: string, args: string[], options?: RunOptions): Promise<void>;
//# sourceMappingURL=spawn.d.ts.map