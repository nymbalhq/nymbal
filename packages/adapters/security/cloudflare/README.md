# @nymbalhq/security-cloudflare

Cloudflare WAF for Nymbal: the `cloudflare` security adapter, with rules applied by command.

```bash
npx nymbal add cloudflare
```

`nymbal add` installs it, sets it in `nymbal.config.ts` and lists the variables it needs in `.env.example`. The API
token needs Zone › Zone › Read, Zone › Zone WAF › Edit, Zone › Cache Rules › Edit and Zone › Transform Rules › Edit on
the zone. `nymbal security:apply` also creates `NYMBAL_ORIGIN_SECRET` and a rule that sends it, so the API answers only
requests that crossed Cloudflare; set it on your host after.
See [Adapters](https://github.com/nymbalhq/nymbal/blob/main/apps/docs/src/content/docs/adapters.md).
