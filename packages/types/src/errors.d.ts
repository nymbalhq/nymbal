export type ErrorContext = Record<string, unknown>;
export declare class NymbalError extends Error {
    readonly code: string;
    readonly context: ErrorContext;
    constructor(code: string, message: string, options?: {
        cause?: unknown;
        context?: ErrorContext;
    });
    toJSON(): {
        name: string;
        code: string;
        message: string;
        context: ErrorContext;
    };
}
export declare class ConfigError extends NymbalError {
    constructor(message: string, options?: {
        cause?: unknown;
        context?: ErrorContext;
    });
}
export declare class ValidationError extends NymbalError {
    constructor(message: string, options?: {
        cause?: unknown;
        context?: ErrorContext;
    });
}
export declare class NotFoundError extends NymbalError {
    constructor(resource: string, identifier: unknown, options?: {
        cause?: unknown;
        context?: ErrorContext;
    });
}
export declare class AdapterError extends NymbalError {
    constructor(code: string, message: string, options?: {
        cause?: unknown;
        context?: ErrorContext;
    });
}
export declare class HttpError extends NymbalError {
    readonly status: number;
    constructor(status: number, message: string, options?: {
        cause?: unknown;
        context?: ErrorContext;
        code?: string;
    });
}
//# sourceMappingURL=errors.d.ts.map