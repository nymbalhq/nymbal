---
'@nymbalhq/types': patch
---

`SettingWriteResult.source` and the `settings.changed` event's `source` can be `'config'` or `'env'`: what still sets a field after its saved value is deleted.
