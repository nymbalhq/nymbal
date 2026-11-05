---
'@nymbalhq/platform': minor
'@nymbalhq/types': minor
'@nymbalhq/config': minor
'@nymbalhq/admin': minor
'nymbal': minor
---

The assistant's writes after it reads store data (a review, an order note, a description) always wait in the Inbox, at most ten a turn, and approval cards show the value now beside the value proposed.
`agents.assistant.customerData: false` keeps tools that answer customer emails, phones and addresses off the assistant; the docs list them. The assistant can no longer clear a saved setting.
`nymbal eval assistant` asks 25 golden questions, five of them injection questions, and exits 0 at 22 or more.
