import { ConfigError } from '@nymbal/types'

export function env(key: string, defaultValue?: string): string {
  const value = process.env[key]
  if (value !== undefined && value !== '') return value
  if (defaultValue !== undefined) return defaultValue
  throw new ConfigError(`Missing required environment variable: ${key}`, {
    context: { key },
  })
}

export function envOptional(key: string): string | undefined {
  const value = process.env[key]
  return value !== undefined && value !== '' ? value : undefined
}

export function envNumber(key: string, defaultValue?: number): number {
  const raw = envOptional(key)
  if (raw === undefined) {
    if (defaultValue !== undefined) return defaultValue
    throw new ConfigError(`Missing required environment variable: ${key}`, { context: { key } })
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    throw new ConfigError(`Environment variable ${key} is not a valid number: ${raw}`, {
      context: { key, raw },
    })
  }
  return parsed
}

export function envBool(key: string, defaultValue = false): boolean {
  const raw = envOptional(key)?.toLowerCase()
  if (raw === undefined) return defaultValue
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on'
}
