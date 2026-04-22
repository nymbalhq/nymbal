export type NymbalEnvironment = 'production' | 'staging' | 'development'

export interface EventMetadata {
  storeId: string
  environment: NymbalEnvironment
  version: string
}

export interface NymbalEvent<T = unknown> {
  id: string
  type: string
  timestamp: string
  source: string
  correlationId: string
  payload: T
  metadata: EventMetadata
}

export type EventHandler<T = unknown> = (event: NymbalEvent<T>) => Promise<void> | void
