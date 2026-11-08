---
'@nymbalhq/platform': minor
---

Ask makes at most three deletions, archives, cancellations or refunds per message and refuses bulk ones, and is no longer offered the store's settings; a route marks these with `destructive: true` and `agents: { assistant: false }`.
A `runAssistantTurn` answer cut at the model's length limit now ends with an `error` frame `assistant.answer_cut` instead of `done`.
