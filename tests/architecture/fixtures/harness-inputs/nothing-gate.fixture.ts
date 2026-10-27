// Reads: nothing
import { gateCli, scratchRepo } from '../../../tooling/scratch-gate'

// Declares nothing and runs the checkout's gate only through a helper.

export const gateCode = async (): Promise<number | null> =>
  (await gateCli(scratchRepo({ 'README.md': 'x\n' }), ['--json'])).code
