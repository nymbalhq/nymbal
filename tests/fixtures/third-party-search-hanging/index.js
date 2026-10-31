// A search adapter that never returns from `createAdapter`: it spins synchronously, so no test timeout inside its
// suite can stop it. The registry run must bound it from outside and go on to the next entry.

export const slot = 'search'
export const provider = 'acme-hanging'

export function createAdapter() {
  for (;;) {
    // spin
  }
}

export const contractOptions = { options: {} }
