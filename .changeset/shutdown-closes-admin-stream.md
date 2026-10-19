---
'@nymbalhq/http': patch
'nymbal': minor
---

Stopping the store no longer hangs while the admin is open. The Fastify adapter's `stop()` now ends every open
event stream cleanly and closes its connection. A stream that would open during shutdown gets a 503. Before, an open
admin tab kept `nymbal dev` running after SIGTERM or SIGINT. After a restart the admin reconnects by itself.

`nymbal dev` shuts down within 3 s. If a step is still pending at that point, it logs the step's name and exits 1. A
second SIGINT or SIGTERM during shutdown exits 1 at once. A shutdown step that fails is logged, and the exit code is 1.

`nymbal dev --port <n>` sets the API port and overrides the config's `http.port`.
