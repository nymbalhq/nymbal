import { pino } from 'pino';
export function createLogger(options = {}) {
    const isProduction = process.env.NODE_ENV === 'production';
    const pretty = options.pretty ?? !isProduction;
    const logger = pino({
        level: options.level ?? process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
        base: options.base ?? {},
        ...(pretty && {
            transport: {
                target: 'pino-pretty',
                options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
            },
        }),
    });
    return wrap(logger);
}
function wrap(p) {
    return {
        trace: (obj, msg) => p.trace(obj, msg),
        debug: (obj, msg) => p.debug(obj, msg),
        info: (obj, msg) => p.info(obj, msg),
        warn: (obj, msg) => p.warn(obj, msg),
        error: (obj, msg) => p.error(obj, msg),
        child: (bindings) => wrap(p.child(bindings)),
    };
}
//# sourceMappingURL=logger.js.map