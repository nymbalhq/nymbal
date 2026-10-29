---
'@nymbalhq/adapter-mailgun': minor
'@nymbalhq/config': minor
'@nymbalhq/platform': minor
---

New `mailgun` email provider (`@nymbalhq/adapter-mailgun`): it sends over Mailgun's SMTP relay, and its bounce and
complaint webhooks stop alert mail to bad addresses. Set Mailgun's webhook URL to `/api/webhooks/mailgun`.
