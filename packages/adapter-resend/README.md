# @nymbalhq/adapter-resend

The `resend` email provider for Nymbal. It sends every transactional mail over Resend's SMTP relay, and takes
Resend's bounce and complaint webhooks, so a permanent bounce or a spam complaint stops alert mail to that address.

```sh
npm install @nymbalhq/adapter-resend nodemailer
```

```ts
// nymbal.config.ts
commerce: {
  email: {
    provider: 'resend',
    config: {
      from: 'shop@example.com', // an address on a domain verified in Resend
      smtp: { pass: env('RESEND_API_KEY') },
      webhookSecret: env('RESEND_WEBHOOK_SECRET'),
    },
  },
}
```

- `smtp.host` defaults to `smtp.resend.com`, `smtp.port` to 587 (STARTTLS) and `smtp.user` to `resend`. For implicit
  TLS set `port: 465, secure: true`.
- `smtp.pass` is a Resend API key with sending access.
- `smtp.pass` and `webhookSecret` may be left out of the config and saved in the admin's Settings instead.
- `webhookSecret` is the webhook's signing secret (`whsec_…`, Resend: Webhooks, the endpoint). Without it the store
  refuses every webhook post and the email slot's health is `degraded`.

## Webhooks

In Resend, add a webhook endpoint at `<api origin>/api/webhooks/resend` subscribed to:

- `email.bounced`
- `email.complained`

A `Permanent` bounce is recorded as a hard bounce (`resend.bounced.v1`) and a complaint as `resend.complained.v1`,
one per recipient; both stop alert mail to the address. A `Transient` or `Undetermined` bounce is soft and stops
nothing. Any other event posted to the same URL is answered 200 and ignored.

Only a post whose Svix signature matches the secret, with a timestamp within five minutes of the server's clock, is
accepted. Resend's retry of a post keeps its `svix-id`, and the store records each id once.
