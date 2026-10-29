---
'@nymbalhq/types': minor
'@nymbalhq/platform': minor
'@nymbalhq/contract-tests': minor
---

Email adapters can report bounces and complaints from `receiveWebhook` as `<provider>.bounced.v1` and
`<provider>.complained.v1`; a hard bounce or a complaint stops alert mail to that address. Webhooks may be
form-encoded or plain text. `runEmailFeedbackContract` certifies an email adapter's bounces and complaints.
