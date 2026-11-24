---
'@nymbalhq/platform': patch
---

On Postgres, a refund whose tax filing failed while another filing of the same order was finishing stays due, so the sweeper retries it.
