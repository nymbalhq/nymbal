import { create } from 'zustand'

interface CommandPaletteStore {
  isOpen: boolean
  /** Counts closes, so the palette resets even when a reopen comes before it renders the close. */
  closes: number
  open: () => void
  close: () => void
  toggle: () => void
}

export const useCommandPalette = create<CommandPaletteStore>((set) => ({
  isOpen: false,
  closes: 0,
  open: () => set({ isOpen: true }),
  close: () => set((state) => (state.isOpen ? { isOpen: false, closes: state.closes + 1 } : {})),
  toggle: () =>
    set((state) => (state.isOpen ? { isOpen: false, closes: state.closes + 1 } : { isOpen: true })),
}))
