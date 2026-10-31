---
'@nymbalhq/platform': minor
---

A delivery that fails while the event bus, document store or a commerce adapter reports itself down no longer uses
up the event's retries: it is tried again at a steady pace and sent once the adapter is back. Each such pass logs one
`outage:` warning naming what is down.
