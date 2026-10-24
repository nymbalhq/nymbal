export function serialiseJson(store: 'sqlite' | 'postgres', value: unknown): unknown {
  if (store === 'sqlite') {
    return JSON.stringify(value)
  }
  return value
}

export function parseJson<T>(store: 'sqlite' | 'postgres', value: unknown, fallback: T): T {
  if (store === 'sqlite' && typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }
  return (value ?? fallback) as T
}

export function toIso(store: 'sqlite' | 'postgres', d: Date): Date | string {
  return store === 'sqlite' ? d.toISOString() : d
}

export function fromTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return String(value)
}
