import { pino, type DestinationStream, type Logger as PinoLogger } from 'pino'
import type { Logger } from '@nymbalhq/types'

export interface CreateLoggerOptions {
  level?: string
  pretty?: boolean
  base?: Record<string, unknown>
  /** Where the JSON lines go instead of stdout; a destination is never pretty-printed. */
  destination?: DestinationStream
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const isProduction = process.env.NODE_ENV === 'production'
  const pretty = options.destination === undefined && (options.pretty ?? !isProduction)
  const settings = {
    level: options.level ?? process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
    base: options.base ?? {},
    ...(pretty && {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    }),
  }
  const logger =
    options.destination === undefined ? pino(settings) : pino(settings, options.destination)
  return wrap(logger)
}

function wrap(p: PinoLogger): Logger {
  return {
    trace: (obj, msg) => p.trace(obj as object, msg),
    debug: (obj, msg) => p.debug(obj as object, msg),
    info: (obj, msg) => p.info(obj as object, msg),
    warn: (obj, msg) => p.warn(obj as object, msg),
    error: (obj, msg) => p.error(obj as object, msg),
    child: (bindings) => wrap(p.child(bindings)),
  }
}
