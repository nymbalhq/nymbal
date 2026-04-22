import { z } from 'zod';
export declare const storeSchema: z.ZodObject<{
    name: z.ZodString;
    currency: z.ZodString;
    locale: z.ZodString;
    timezone: z.ZodString;
}, "strip", z.ZodTypeAny, {
    name: string;
    currency: string;
    locale: string;
    timezone: string;
}, {
    name: string;
    currency: string;
    locale: string;
    timezone: string;
}>;
export declare const infrastructureSchema: z.ZodObject<{
    cloud: z.ZodEnum<["local", "aws", "gcp", "azure", "docker"]>;
    commandStore: z.ZodEnum<["sqlite", "postgres"]>;
    documentStore: z.ZodEnum<["in-memory", "dynamodb", "firestore", "cosmosdb", "postgres-jsonb"]>;
    eventBus: z.ZodEnum<["in-process", "eventbridge", "pubsub", "service-bus", "redis-streams"]>;
    compute: z.ZodEnum<["in-process", "lambda", "cloud-functions", "azure-functions", "worker-threads"]>;
}, "strip", z.ZodTypeAny, {
    cloud: "local" | "aws" | "gcp" | "azure" | "docker";
    commandStore: "sqlite" | "postgres";
    documentStore: "in-memory" | "dynamodb" | "firestore" | "cosmosdb" | "postgres-jsonb";
    eventBus: "in-process" | "eventbridge" | "pubsub" | "service-bus" | "redis-streams";
    compute: "in-process" | "lambda" | "cloud-functions" | "azure-functions" | "worker-threads";
}, {
    cloud: "local" | "aws" | "gcp" | "azure" | "docker";
    commandStore: "sqlite" | "postgres";
    documentStore: "in-memory" | "dynamodb" | "firestore" | "cosmosdb" | "postgres-jsonb";
    eventBus: "in-process" | "eventbridge" | "pubsub" | "service-bus" | "redis-streams";
    compute: "in-process" | "lambda" | "cloud-functions" | "azure-functions" | "worker-threads";
}>;
export declare const securitySchema: z.ZodObject<{
    adapter: z.ZodEnum<["middleware", "cloudflare", "aws-waf", "akamai"]>;
    rateLimit: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
        requests: z.ZodNumber;
        window: z.ZodString;
        action: z.ZodEnum<["block", "challenge", "throttle"]>;
    }, "strip", z.ZodTypeAny, {
        requests: number;
        window: string;
        action: "block" | "challenge" | "throttle";
    }, {
        requests: number;
        window: string;
        action: "block" | "challenge" | "throttle";
    }>>>;
    botProtection: z.ZodDefault<z.ZodObject<{
        mode: z.ZodDefault<z.ZodEnum<["off", "managed", "strict"]>>;
        allowList: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        mode: "strict" | "off" | "managed";
        allowList: string[];
    }, {
        mode?: "strict" | "off" | "managed" | undefined;
        allowList?: string[] | undefined;
    }>>;
    headers: z.ZodDefault<z.ZodObject<{
        hsts: z.ZodDefault<z.ZodBoolean>;
        contentSecurityPolicy: z.ZodDefault<z.ZodUnion<[z.ZodEnum<["strict", "relaxed", "off"]>, z.ZodString]>>;
        referrerPolicy: z.ZodDefault<z.ZodString>;
        xFrameOptions: z.ZodDefault<z.ZodEnum<["deny", "sameorigin"]>>;
    }, "strip", z.ZodTypeAny, {
        hsts: boolean;
        contentSecurityPolicy: string;
        referrerPolicy: string;
        xFrameOptions: "deny" | "sameorigin";
    }, {
        hsts?: boolean | undefined;
        contentSecurityPolicy?: string | undefined;
        referrerPolicy?: string | undefined;
        xFrameOptions?: "deny" | "sameorigin" | undefined;
    }>>;
    csrf: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    adapter: "middleware" | "cloudflare" | "aws-waf" | "akamai";
    rateLimit: Record<string, {
        requests: number;
        window: string;
        action: "block" | "challenge" | "throttle";
    }>;
    botProtection: {
        mode: "strict" | "off" | "managed";
        allowList: string[];
    };
    headers: {
        hsts: boolean;
        contentSecurityPolicy: string;
        referrerPolicy: string;
        xFrameOptions: "deny" | "sameorigin";
    };
    csrf: boolean;
}, {
    adapter: "middleware" | "cloudflare" | "aws-waf" | "akamai";
    rateLimit?: Record<string, {
        requests: number;
        window: string;
        action: "block" | "challenge" | "throttle";
    }> | undefined;
    botProtection?: {
        mode?: "strict" | "off" | "managed" | undefined;
        allowList?: string[] | undefined;
    } | undefined;
    headers?: {
        hsts?: boolean | undefined;
        contentSecurityPolicy?: string | undefined;
        referrerPolicy?: string | undefined;
        xFrameOptions?: "deny" | "sameorigin" | undefined;
    } | undefined;
    csrf?: boolean | undefined;
}>;
export declare const commerceSchema: z.ZodObject<{
    payments: z.ZodObject<{
        provider: z.ZodString;
        config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        provider: string;
        config?: Record<string, unknown> | undefined;
    }, {
        provider: string;
        config?: Record<string, unknown> | undefined;
    }>;
    email: z.ZodObject<{
        provider: z.ZodString;
        config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        provider: string;
        config?: Record<string, unknown> | undefined;
    }, {
        provider: string;
        config?: Record<string, unknown> | undefined;
    }>;
    reviews: z.ZodObject<{
        provider: z.ZodString;
        config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        provider: string;
        config?: Record<string, unknown> | undefined;
    }, {
        provider: string;
        config?: Record<string, unknown> | undefined;
    }>;
    search: z.ZodObject<{
        provider: z.ZodString;
        config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        provider: string;
        config?: Record<string, unknown> | undefined;
    }, {
        provider: string;
        config?: Record<string, unknown> | undefined;
    }>;
    analytics: z.ZodObject<{
        provider: z.ZodString;
        config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        provider: string;
        config?: Record<string, unknown> | undefined;
    }, {
        provider: string;
        config?: Record<string, unknown> | undefined;
    }>;
    shipping: z.ZodObject<{
        provider: z.ZodString;
        config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        provider: string;
        config?: Record<string, unknown> | undefined;
    }, {
        provider: string;
        config?: Record<string, unknown> | undefined;
    }>;
    tax: z.ZodObject<{
        provider: z.ZodString;
        config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        provider: string;
        config?: Record<string, unknown> | undefined;
    }, {
        provider: string;
        config?: Record<string, unknown> | undefined;
    }>;
    ai: z.ZodObject<{
        provider: z.ZodString;
        config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        provider: string;
        config?: Record<string, unknown> | undefined;
    }, {
        provider: string;
        config?: Record<string, unknown> | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    search: {
        provider: string;
        config?: Record<string, unknown> | undefined;
    };
    payments: {
        provider: string;
        config?: Record<string, unknown> | undefined;
    };
    email: {
        provider: string;
        config?: Record<string, unknown> | undefined;
    };
    reviews: {
        provider: string;
        config?: Record<string, unknown> | undefined;
    };
    analytics: {
        provider: string;
        config?: Record<string, unknown> | undefined;
    };
    shipping: {
        provider: string;
        config?: Record<string, unknown> | undefined;
    };
    tax: {
        provider: string;
        config?: Record<string, unknown> | undefined;
    };
    ai: {
        provider: string;
        config?: Record<string, unknown> | undefined;
    };
}, {
    search: {
        provider: string;
        config?: Record<string, unknown> | undefined;
    };
    payments: {
        provider: string;
        config?: Record<string, unknown> | undefined;
    };
    email: {
        provider: string;
        config?: Record<string, unknown> | undefined;
    };
    reviews: {
        provider: string;
        config?: Record<string, unknown> | undefined;
    };
    analytics: {
        provider: string;
        config?: Record<string, unknown> | undefined;
    };
    shipping: {
        provider: string;
        config?: Record<string, unknown> | undefined;
    };
    tax: {
        provider: string;
        config?: Record<string, unknown> | undefined;
    };
    ai: {
        provider: string;
        config?: Record<string, unknown> | undefined;
    };
}>;
export declare const httpSchema: z.ZodObject<{
    adapter: z.ZodDefault<z.ZodEnum<["fastify", "hono"]>>;
    port: z.ZodDefault<z.ZodNumber>;
    host: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    adapter: "fastify" | "hono";
    port: number;
    host: string;
}, {
    adapter?: "fastify" | "hono" | undefined;
    port?: number | undefined;
    host?: string | undefined;
}>;
export declare const deploymentSchema: z.ZodObject<{
    strategy: z.ZodDefault<z.ZodEnum<["standard", "blue-green"]>>;
}, "strip", z.ZodTypeAny, {
    strategy: "standard" | "blue-green";
}, {
    strategy?: "standard" | "blue-green" | undefined;
}>;
export declare const featuresSchema: z.ZodObject<{
    staging: z.ZodDefault<z.ZodBoolean>;
    heartbeat: z.ZodDefault<z.ZodBoolean>;
    autoUpdates: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    staging: boolean;
    heartbeat: boolean;
    autoUpdates: boolean;
}, {
    staging?: boolean | undefined;
    heartbeat?: boolean | undefined;
    autoUpdates?: boolean | undefined;
}>;
export declare const nymbalConfigSchema: z.ZodEffects<z.ZodObject<{
    store: z.ZodObject<{
        name: z.ZodString;
        currency: z.ZodString;
        locale: z.ZodString;
        timezone: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        name: string;
        currency: string;
        locale: string;
        timezone: string;
    }, {
        name: string;
        currency: string;
        locale: string;
        timezone: string;
    }>;
    template: z.ZodEnum<["astro", "nextjs"]>;
    infrastructure: z.ZodObject<{
        cloud: z.ZodEnum<["local", "aws", "gcp", "azure", "docker"]>;
        commandStore: z.ZodEnum<["sqlite", "postgres"]>;
        documentStore: z.ZodEnum<["in-memory", "dynamodb", "firestore", "cosmosdb", "postgres-jsonb"]>;
        eventBus: z.ZodEnum<["in-process", "eventbridge", "pubsub", "service-bus", "redis-streams"]>;
        compute: z.ZodEnum<["in-process", "lambda", "cloud-functions", "azure-functions", "worker-threads"]>;
    }, "strip", z.ZodTypeAny, {
        cloud: "local" | "aws" | "gcp" | "azure" | "docker";
        commandStore: "sqlite" | "postgres";
        documentStore: "in-memory" | "dynamodb" | "firestore" | "cosmosdb" | "postgres-jsonb";
        eventBus: "in-process" | "eventbridge" | "pubsub" | "service-bus" | "redis-streams";
        compute: "in-process" | "lambda" | "cloud-functions" | "azure-functions" | "worker-threads";
    }, {
        cloud: "local" | "aws" | "gcp" | "azure" | "docker";
        commandStore: "sqlite" | "postgres";
        documentStore: "in-memory" | "dynamodb" | "firestore" | "cosmosdb" | "postgres-jsonb";
        eventBus: "in-process" | "eventbridge" | "pubsub" | "service-bus" | "redis-streams";
        compute: "in-process" | "lambda" | "cloud-functions" | "azure-functions" | "worker-threads";
    }>;
    security: z.ZodObject<{
        adapter: z.ZodEnum<["middleware", "cloudflare", "aws-waf", "akamai"]>;
        rateLimit: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
            requests: z.ZodNumber;
            window: z.ZodString;
            action: z.ZodEnum<["block", "challenge", "throttle"]>;
        }, "strip", z.ZodTypeAny, {
            requests: number;
            window: string;
            action: "block" | "challenge" | "throttle";
        }, {
            requests: number;
            window: string;
            action: "block" | "challenge" | "throttle";
        }>>>;
        botProtection: z.ZodDefault<z.ZodObject<{
            mode: z.ZodDefault<z.ZodEnum<["off", "managed", "strict"]>>;
            allowList: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        }, "strip", z.ZodTypeAny, {
            mode: "strict" | "off" | "managed";
            allowList: string[];
        }, {
            mode?: "strict" | "off" | "managed" | undefined;
            allowList?: string[] | undefined;
        }>>;
        headers: z.ZodDefault<z.ZodObject<{
            hsts: z.ZodDefault<z.ZodBoolean>;
            contentSecurityPolicy: z.ZodDefault<z.ZodUnion<[z.ZodEnum<["strict", "relaxed", "off"]>, z.ZodString]>>;
            referrerPolicy: z.ZodDefault<z.ZodString>;
            xFrameOptions: z.ZodDefault<z.ZodEnum<["deny", "sameorigin"]>>;
        }, "strip", z.ZodTypeAny, {
            hsts: boolean;
            contentSecurityPolicy: string;
            referrerPolicy: string;
            xFrameOptions: "deny" | "sameorigin";
        }, {
            hsts?: boolean | undefined;
            contentSecurityPolicy?: string | undefined;
            referrerPolicy?: string | undefined;
            xFrameOptions?: "deny" | "sameorigin" | undefined;
        }>>;
        csrf: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        adapter: "middleware" | "cloudflare" | "aws-waf" | "akamai";
        rateLimit: Record<string, {
            requests: number;
            window: string;
            action: "block" | "challenge" | "throttle";
        }>;
        botProtection: {
            mode: "strict" | "off" | "managed";
            allowList: string[];
        };
        headers: {
            hsts: boolean;
            contentSecurityPolicy: string;
            referrerPolicy: string;
            xFrameOptions: "deny" | "sameorigin";
        };
        csrf: boolean;
    }, {
        adapter: "middleware" | "cloudflare" | "aws-waf" | "akamai";
        rateLimit?: Record<string, {
            requests: number;
            window: string;
            action: "block" | "challenge" | "throttle";
        }> | undefined;
        botProtection?: {
            mode?: "strict" | "off" | "managed" | undefined;
            allowList?: string[] | undefined;
        } | undefined;
        headers?: {
            hsts?: boolean | undefined;
            contentSecurityPolicy?: string | undefined;
            referrerPolicy?: string | undefined;
            xFrameOptions?: "deny" | "sameorigin" | undefined;
        } | undefined;
        csrf?: boolean | undefined;
    }>;
    commerce: z.ZodObject<{
        payments: z.ZodObject<{
            provider: z.ZodString;
            config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, "strip", z.ZodTypeAny, {
            provider: string;
            config?: Record<string, unknown> | undefined;
        }, {
            provider: string;
            config?: Record<string, unknown> | undefined;
        }>;
        email: z.ZodObject<{
            provider: z.ZodString;
            config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, "strip", z.ZodTypeAny, {
            provider: string;
            config?: Record<string, unknown> | undefined;
        }, {
            provider: string;
            config?: Record<string, unknown> | undefined;
        }>;
        reviews: z.ZodObject<{
            provider: z.ZodString;
            config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, "strip", z.ZodTypeAny, {
            provider: string;
            config?: Record<string, unknown> | undefined;
        }, {
            provider: string;
            config?: Record<string, unknown> | undefined;
        }>;
        search: z.ZodObject<{
            provider: z.ZodString;
            config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, "strip", z.ZodTypeAny, {
            provider: string;
            config?: Record<string, unknown> | undefined;
        }, {
            provider: string;
            config?: Record<string, unknown> | undefined;
        }>;
        analytics: z.ZodObject<{
            provider: z.ZodString;
            config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, "strip", z.ZodTypeAny, {
            provider: string;
            config?: Record<string, unknown> | undefined;
        }, {
            provider: string;
            config?: Record<string, unknown> | undefined;
        }>;
        shipping: z.ZodObject<{
            provider: z.ZodString;
            config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, "strip", z.ZodTypeAny, {
            provider: string;
            config?: Record<string, unknown> | undefined;
        }, {
            provider: string;
            config?: Record<string, unknown> | undefined;
        }>;
        tax: z.ZodObject<{
            provider: z.ZodString;
            config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, "strip", z.ZodTypeAny, {
            provider: string;
            config?: Record<string, unknown> | undefined;
        }, {
            provider: string;
            config?: Record<string, unknown> | undefined;
        }>;
        ai: z.ZodObject<{
            provider: z.ZodString;
            config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, "strip", z.ZodTypeAny, {
            provider: string;
            config?: Record<string, unknown> | undefined;
        }, {
            provider: string;
            config?: Record<string, unknown> | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        search: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        payments: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        email: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        reviews: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        analytics: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        shipping: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        tax: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        ai: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
    }, {
        search: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        payments: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        email: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        reviews: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        analytics: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        shipping: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        tax: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        ai: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
    }>;
    http: z.ZodObject<{
        adapter: z.ZodDefault<z.ZodEnum<["fastify", "hono"]>>;
        port: z.ZodDefault<z.ZodNumber>;
        host: z.ZodDefault<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        adapter: "fastify" | "hono";
        port: number;
        host: string;
    }, {
        adapter?: "fastify" | "hono" | undefined;
        port?: number | undefined;
        host?: string | undefined;
    }>;
    deployment: z.ZodObject<{
        strategy: z.ZodDefault<z.ZodEnum<["standard", "blue-green"]>>;
    }, "strip", z.ZodTypeAny, {
        strategy: "standard" | "blue-green";
    }, {
        strategy?: "standard" | "blue-green" | undefined;
    }>;
    features: z.ZodDefault<z.ZodObject<{
        staging: z.ZodDefault<z.ZodBoolean>;
        heartbeat: z.ZodDefault<z.ZodBoolean>;
        autoUpdates: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        staging: boolean;
        heartbeat: boolean;
        autoUpdates: boolean;
    }, {
        staging?: boolean | undefined;
        heartbeat?: boolean | undefined;
        autoUpdates?: boolean | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    store: {
        name: string;
        currency: string;
        locale: string;
        timezone: string;
    };
    template: "astro" | "nextjs";
    infrastructure: {
        cloud: "local" | "aws" | "gcp" | "azure" | "docker";
        commandStore: "sqlite" | "postgres";
        documentStore: "in-memory" | "dynamodb" | "firestore" | "cosmosdb" | "postgres-jsonb";
        eventBus: "in-process" | "eventbridge" | "pubsub" | "service-bus" | "redis-streams";
        compute: "in-process" | "lambda" | "cloud-functions" | "azure-functions" | "worker-threads";
    };
    security: {
        adapter: "middleware" | "cloudflare" | "aws-waf" | "akamai";
        rateLimit: Record<string, {
            requests: number;
            window: string;
            action: "block" | "challenge" | "throttle";
        }>;
        botProtection: {
            mode: "strict" | "off" | "managed";
            allowList: string[];
        };
        headers: {
            hsts: boolean;
            contentSecurityPolicy: string;
            referrerPolicy: string;
            xFrameOptions: "deny" | "sameorigin";
        };
        csrf: boolean;
    };
    commerce: {
        search: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        payments: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        email: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        reviews: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        analytics: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        shipping: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        tax: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        ai: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
    };
    http: {
        adapter: "fastify" | "hono";
        port: number;
        host: string;
    };
    deployment: {
        strategy: "standard" | "blue-green";
    };
    features: {
        staging: boolean;
        heartbeat: boolean;
        autoUpdates: boolean;
    };
}, {
    store: {
        name: string;
        currency: string;
        locale: string;
        timezone: string;
    };
    template: "astro" | "nextjs";
    infrastructure: {
        cloud: "local" | "aws" | "gcp" | "azure" | "docker";
        commandStore: "sqlite" | "postgres";
        documentStore: "in-memory" | "dynamodb" | "firestore" | "cosmosdb" | "postgres-jsonb";
        eventBus: "in-process" | "eventbridge" | "pubsub" | "service-bus" | "redis-streams";
        compute: "in-process" | "lambda" | "cloud-functions" | "azure-functions" | "worker-threads";
    };
    security: {
        adapter: "middleware" | "cloudflare" | "aws-waf" | "akamai";
        rateLimit?: Record<string, {
            requests: number;
            window: string;
            action: "block" | "challenge" | "throttle";
        }> | undefined;
        botProtection?: {
            mode?: "strict" | "off" | "managed" | undefined;
            allowList?: string[] | undefined;
        } | undefined;
        headers?: {
            hsts?: boolean | undefined;
            contentSecurityPolicy?: string | undefined;
            referrerPolicy?: string | undefined;
            xFrameOptions?: "deny" | "sameorigin" | undefined;
        } | undefined;
        csrf?: boolean | undefined;
    };
    commerce: {
        search: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        payments: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        email: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        reviews: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        analytics: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        shipping: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        tax: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        ai: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
    };
    http: {
        adapter?: "fastify" | "hono" | undefined;
        port?: number | undefined;
        host?: string | undefined;
    };
    deployment: {
        strategy?: "standard" | "blue-green" | undefined;
    };
    features?: {
        staging?: boolean | undefined;
        heartbeat?: boolean | undefined;
        autoUpdates?: boolean | undefined;
    } | undefined;
}>, {
    store: {
        name: string;
        currency: string;
        locale: string;
        timezone: string;
    };
    template: "astro" | "nextjs";
    infrastructure: {
        cloud: "local" | "aws" | "gcp" | "azure" | "docker";
        commandStore: "sqlite" | "postgres";
        documentStore: "in-memory" | "dynamodb" | "firestore" | "cosmosdb" | "postgres-jsonb";
        eventBus: "in-process" | "eventbridge" | "pubsub" | "service-bus" | "redis-streams";
        compute: "in-process" | "lambda" | "cloud-functions" | "azure-functions" | "worker-threads";
    };
    security: {
        adapter: "middleware" | "cloudflare" | "aws-waf" | "akamai";
        rateLimit: Record<string, {
            requests: number;
            window: string;
            action: "block" | "challenge" | "throttle";
        }>;
        botProtection: {
            mode: "strict" | "off" | "managed";
            allowList: string[];
        };
        headers: {
            hsts: boolean;
            contentSecurityPolicy: string;
            referrerPolicy: string;
            xFrameOptions: "deny" | "sameorigin";
        };
        csrf: boolean;
    };
    commerce: {
        search: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        payments: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        email: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        reviews: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        analytics: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        shipping: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        tax: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        ai: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
    };
    http: {
        adapter: "fastify" | "hono";
        port: number;
        host: string;
    };
    deployment: {
        strategy: "standard" | "blue-green";
    };
    features: {
        staging: boolean;
        heartbeat: boolean;
        autoUpdates: boolean;
    };
}, {
    store: {
        name: string;
        currency: string;
        locale: string;
        timezone: string;
    };
    template: "astro" | "nextjs";
    infrastructure: {
        cloud: "local" | "aws" | "gcp" | "azure" | "docker";
        commandStore: "sqlite" | "postgres";
        documentStore: "in-memory" | "dynamodb" | "firestore" | "cosmosdb" | "postgres-jsonb";
        eventBus: "in-process" | "eventbridge" | "pubsub" | "service-bus" | "redis-streams";
        compute: "in-process" | "lambda" | "cloud-functions" | "azure-functions" | "worker-threads";
    };
    security: {
        adapter: "middleware" | "cloudflare" | "aws-waf" | "akamai";
        rateLimit?: Record<string, {
            requests: number;
            window: string;
            action: "block" | "challenge" | "throttle";
        }> | undefined;
        botProtection?: {
            mode?: "strict" | "off" | "managed" | undefined;
            allowList?: string[] | undefined;
        } | undefined;
        headers?: {
            hsts?: boolean | undefined;
            contentSecurityPolicy?: string | undefined;
            referrerPolicy?: string | undefined;
            xFrameOptions?: "deny" | "sameorigin" | undefined;
        } | undefined;
        csrf?: boolean | undefined;
    };
    commerce: {
        search: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        payments: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        email: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        reviews: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        analytics: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        shipping: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        tax: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
        ai: {
            provider: string;
            config?: Record<string, unknown> | undefined;
        };
    };
    http: {
        adapter?: "fastify" | "hono" | undefined;
        port?: number | undefined;
        host?: string | undefined;
    };
    deployment: {
        strategy?: "standard" | "blue-green" | undefined;
    };
    features?: {
        staging?: boolean | undefined;
        heartbeat?: boolean | undefined;
        autoUpdates?: boolean | undefined;
    } | undefined;
}>;
export type NymbalConfigInput = z.input<typeof nymbalConfigSchema>;
export type NymbalConfig = z.output<typeof nymbalConfigSchema>;
//# sourceMappingURL=schema.d.ts.map