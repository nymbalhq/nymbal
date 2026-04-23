// Mulberry32 — fast, seedable, good statistical properties
let state = 0x9e3779b9
let counter = 0

export function seedRandom(seed: number): void {
  state = seed >>> 0
  counter = 0
}

export function resetRandom(): void {
  state = 0x9e3779b9
  counter = 0
}

export function rand(): number {
  state = (state + 0x6d2b79f5) >>> 0
  let z = state
  z = Math.imul(z ^ (z >>> 15), z | 1)
  z ^= z + Math.imul(z ^ (z >>> 7), z | 61)
  return ((z ^ (z >>> 14)) >>> 0) / 0x100000000
}

export function randInt(min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min
}

export function nextId(): string {
  const a = Math.floor(rand() * 0xffffffff).toString(16).padStart(8, '0')
  const b = Math.floor(rand() * 0xffff).toString(16).padStart(4, '0')
  const c = Math.floor(rand() * 0xffff).toString(16).padStart(4, '0')
  const d = Math.floor(rand() * 0xffff).toString(16).padStart(4, '0')
  const e = (++counter).toString(16).padStart(4, '0') +
            Math.floor(rand() * 0xffffffff).toString(16).padStart(8, '0')
  return `${a}-${b}-4${c.slice(1)}-${d}-${e}`
}

export function isoDate(offsetDays = 0): string {
  const d = new Date(Date.UTC(2024, 0, 1))
  d.setUTCDate(d.getUTCDate() + offsetDays)
  return d.toISOString()
}
