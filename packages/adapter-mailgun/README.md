# @nymbalhq/adapter-mailgun

The `mailgun` email provider for Nymbal. It sends every transactional mail over Mailgun's SMTP relay, and takes
Mailgun's bounce and complaint webhooks, so a permanent failure or a spam complaint stops alert mail to that address.

```sh
npm install @nymbalhq/adapter-mailgun nodemailer
```

```ts
// nymbal.config.ts
commerce: {
  email: {
    provider: 'mailgun',
    config: {
      from: 'shop@mg.example.com',
      region: 'us', // 'eu' for a domain in Mailgun's EU region
      smtp: { user: 'postmaster@mg.example.com', pass: env('MAILGUN_SMTP_PASSWORD') },
      webhookSigningKey: env('MAILGUN_WEBHOOK_SIGNING_KEY'),
    },
  },
}
```

- `smtp.host` defaults to `smtp.mailgun.org` (`smtp.eu.mailgun.org` for `region: 'eu'`) and `smtp.port` to 587.
- `smtp.pass` and `webhookSigningKey` may be left out of the config and saved in the admin's Settings instead.
- `webhookSigningKey` is the domain's HTTP webhook signing key (Mailgun: Sending, Webhooks). Without it the store
  refuses every webhook post and the email slot's health is `degraded`.

## Webhooks

In Mailgun, for the sending domain, point these webhooks at `<api origin>/api/webhooks/mailgun`:

- Permanent failure
- Temporary failure
- Spam complaint

A permanent failure is recorded as a hard bounce (`mailgun.bounced.v1`) and a complaint as `mailgun.complained.v1`;
both stop alert mail to the address. A temporary failure is a soft bounce and stops nothing. Any other event posted
to the same URL is answered 200 and ignored.

Only a post signed with the key, with a timestamp within five minutes of the server's clock, is accepted. Each
signature is accepted for one event: Mailgun's retry of that event is accepted again, the same signature on any other
event is refused. That memory is per API process.
