---
'@nymbalhq/adapter-ses': minor
'@nymbalhq/config': minor
'@nymbalhq/platform': minor
---

New `ses` email provider (`@nymbalhq/adapter-ses`): it sends over Amazon SES SMTP, and its SNS bounce and complaint
notifications stop alert mail to bad addresses. Subscribe the SNS topic to `/api/webhooks/ses` over HTTPS.
