import { v7 as uuidv7 } from 'uuid'
import type { NymbalEvent, NymbalEnvironment } from '@nymbal/types'

export interface EventBuilderContext {
  storeId: string
  environment: NymbalEnvironment
  version: string
  source?: string
}

export interface MakeEventOptions {
  source?: string
  correlationId?: string
  timestamp?: Date
}

export function createEventBuilder(ctx: EventBuilderContext) {
  return function makeEvent<T>(
    type: string,
    payload: T,
    options: MakeEventOptions = {},
  ): NymbalEvent<T> {
    const id = uuidv7()
    return {
      id,
      type,
      timestamp: (options.timestamp ?? new Date()).toISOString(),
      source: options.source ?? ctx.source ?? 'nymbal-platform',
      correlationId: options.correlationId ?? id,
      payload,
      metadata: {
        storeId: ctx.storeId,
        environment: ctx.environment,
        version: ctx.version,
      },
    }
  }
}
