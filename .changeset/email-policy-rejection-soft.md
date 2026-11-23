---
'@nymbalhq/email-mailgun': patch
'@nymbalhq/email-ses': patch
'@nymbalhq/email-resend': patch
---

A recipient's server refusing the sender (SMTP status 5.7.x, such as a blocklisted sending IP) is now a soft bounce, so it no longer suppresses the address.
