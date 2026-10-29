---
'@nymbalhq/adapter-resend': minor
'@nymbalhq/config': minor
'@nymbalhq/platform': minor
---

New `resend` email provider (`@nymbalhq/adapter-resend`): it sends over Resend's SMTP relay, and its bounce and
complaint webhooks stop alert mail to bad addresses. Set Resend's webhook URL to `/api/webhooks/resend`.
