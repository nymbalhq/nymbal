# @nymbalhq/adapter-ses

The `ses` email provider for Nymbal. It sends every transactional mail over Amazon SES's SMTP interface, and takes
the bounce and complaint notifications SES publishes to an SNS topic, so a permanent bounce or a spam complaint stops
alert mail to that address. It needs no AWS SDK.

```sh
npm install @nymbalhq/adapter-ses nodemailer
```

```ts
// nymbal.config.ts
commerce: {
  email: {
    provider: 'ses',
    config: {
      from: 'shop@example.com', // an address on an identity verified in SES
      region: 'us-east-1',
      smtp: { user: env('SES_SMTP_USER'), pass: env('SES_SMTP_PASSWORD') },
      topicArn: 'arn:aws:sns:us-east-1:123456789012:shop-ses-feedback',
    },
  },
}
```

- `smtp.host` defaults to `email-smtp.<region>.amazonaws.com` and `smtp.port` to 587 (STARTTLS). For implicit TLS
  set `port: 465, secure: true`.
- `smtp.user` and `smtp.pass` are SES SMTP credentials (SES: SMTP settings, Create SMTP credentials), not an IAM
  access key pair.
- `smtp.user`, `smtp.pass` and `topicArn` may be left out of the config and saved in the admin's Settings instead.
- `topicArn` is the SNS topic below. Without it the store refuses every SNS post and the email slot's health is
  `degraded`.

## Bounces and complaints

1. In SNS, create a standard topic, and put its ARN in `topicArn`.
2. Add a subscription to it: protocol HTTPS, endpoint `<api origin>/api/webhooks/ses`, raw message delivery off.
   The store confirms the subscription itself when SNS posts the confirmation.
   If that confirmation fails, the subscription stays pending; request confirmation again from the SNS console.
3. In SES, on the sending identity, set the Bounce and Complaint feedback notifications to the topic (or, with a
   configuration set, add an SNS event destination for bounces and complaints on it).

A `Permanent` bounce is recorded as a hard bounce (`ses.bounced.v1`) and a complaint as `ses.complained.v1`, one per
recipient; both stop alert mail to the address. A `Transient` or `Undetermined` bounce is soft and stops nothing. Any
other notification on the topic (`Delivery`, for one) is answered 200 and ignored.

Only a message for the configured topic, signed by SNS with a certificate from an `sns.<region>.amazonaws.com` URL,
is accepted. SNS's retry of a message keeps its `MessageId`, and the store records each id once. If SNS reports the
store unsubscribed, the store logs a warning; subscribe the endpoint again to resume.
