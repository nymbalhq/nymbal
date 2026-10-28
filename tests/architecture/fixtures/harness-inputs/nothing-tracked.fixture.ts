// Reads: nothing
import { trackedFiles } from '../../workspace-manifests'

// Declares nothing and reaches the checkout only through a helper: the tracked list.

export const workflows = (): string[] => trackedFiles().filter((f) => f.startsWith('.github/'))
