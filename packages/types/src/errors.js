export class NymbalError extends Error {
    code;
    context;
    constructor(code, message, options = {}) {
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = this.constructor.name;
        this.code = code;
        this.context = options.context ?? {};
    }
    toJSON() {
        return { name: this.name, code: this.code, message: this.message, context: this.context };
    }
}
export class ConfigError extends NymbalError {
    constructor(message, options = {}) {
        super('config.invalid', message, options);
    }
}
export class ValidationError extends NymbalError {
    constructor(message, options = {}) {
        super('validation.failed', message, options);
    }
}
export class NotFoundError extends NymbalError {
    constructor(resource, identifier, options = {}) {
        super('not_found', `${resource} not found: ${String(identifier)}`, {
            ...options,
            context: { resource, identifier, ...(options.context ?? {}) },
        });
    }
}
export class AdapterError extends NymbalError {
    constructor(code, message, options = {}) {
        super(`adapter.${code}`, message, options);
    }
}
export class HttpError extends NymbalError {
    status;
    constructor(status, message, options = {}) {
        super(options.code ?? `http.${status}`, message, options);
        this.status = status;
    }
}
//# sourceMappingURL=errors.js.map