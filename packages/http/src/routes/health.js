export function createHealthRoute(version) {
    return () => ({
        status: 200,
        body: { status: 'ok', version, timestamp: new Date().toISOString() },
    });
}
//# sourceMappingURL=health.js.map