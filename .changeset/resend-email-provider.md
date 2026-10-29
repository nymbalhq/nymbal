---
'@nymbalhq/email-resend': minor
'@nymbalhq/config': minor
'@nymbalhq/platform': minor
---

New `resend` email provider (`@nymbalhq/email-resend`): it sends over Resend's SMTP relay, and its bounce and
complaint webhooks stop alert mail to bad addresses. Set Resend's webhook URL to `/api/webhooks/resend`.
