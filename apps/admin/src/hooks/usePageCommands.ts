import { create } from 'zustand'
import type { PaletteCommand } from '@/lib/palette-commands'

export interface RunnableCommand extends PaletteCommand {
  run: () => void
}

export interface PageCommandScope {
  title: string
  commands: RunnableCommand[]
}

interface PageCommandsStore {
  /** The commands of what the open page shows, or null when it offers none. */
  scope: PageCommandScope | null
  setScope: (scope: PageCommandScope) => void
  clearScope: () => void
}

export const usePageCommands = create<PageCommandsStore>((set) => ({
  scope: null,
  setScope: (scope) => set({ scope }),
  clearScope: () => set({ scope: null }),
}))
