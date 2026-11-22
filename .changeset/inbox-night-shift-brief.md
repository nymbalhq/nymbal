---
'@nymbalhq/types': minor
'@nymbalhq/platform': minor
'@nymbalhq/admin': minor
---

The admin's Inbox shows the night shift's open insights, most serious first, each with Dismiss: a dismissed subject stays quiet for 7 days. Agents read the list through `GET /api/admin/insights` and the `admin_insights_list` tool. New event `insight.dismissed.v1`.
