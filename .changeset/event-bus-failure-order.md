---
'@nymbalhq/contract-tests': patch
---

The event bus handler-failure case checks that the other handlers finished before the publish settled by their order, not by how long it took, so it no longer fails an adapter on a busy machine.
