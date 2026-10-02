# Notifications

DeviceYard sends branded HTML email with a plain-text alternative through an
operator-configured SMTP relay. Use any compatible hosted provider, company
relay, or your own server. No provider account is built into the application.

## Personal settings

Open **Notifications** in the account menu. Verify your email address, then
choose **Off**, **Failures only**, or **All completed runs** separately for each
organisation. Changes take effect when you click **Save preferences**. Existing
accounts start with optional notifications off. Invitations, verification, and
password resets are transactional messages and do not depend on these choices.

Email is the available channel. Push, Slack, and Webhooks are visible as
**Coming later**; they cannot be configured yet.

Admins may enable device-health emails. A device must remain observably offline
for two minutes before an alert is queued. Brief disconnects are silent.
Recovery goes only to recipients whose outage email was accepted by SMTP.
Missing observations restart an unconfirmed debounce. Monitoring happens in the
background, independently of dashboard visits. A stopped service cannot report
its own outage; use external uptime monitoring for that case.

## SMTP setup

Configure these environment variables through your deployment's secret/config
management. SMTP is disabled when configuration is absent. Partial or invalid
configuration disables email and shows a safe diagnostic in Admin; existing
login and run execution keep working.

| Variable | Meaning |
|---|---|
| `SMTP_HOST` | SMTP relay hostname |
| `SMTP_PORT` | Explicit port, usually 465 for TLS or 587 for STARTTLS |
| `SMTP_TLS` | `tls` for implicit TLS, `starttls` for mandatory upgrade, `none` for local development only |
| `SMTP_FROM` | Sender email address authorised by the relay |
| `SMTP_FROM_NAME` | Display name; defaults to DeviceYard |
| `PUBLIC_APP_URL` | Trusted public application URL; HTTPS required except loopback development |
| `SMTP_USER` | Optional authentication username; required with password |
| `SMTP_PASSWORD` | SMTP credential supplied from secret storage |
| `SMTP_CONNECTION_TIMEOUT_MS` | Connection timeout; defaults to 10000 |
| `SMTP_SEND_TIMEOUT_MS` | Send deadline; defaults to 15000, maximum 60000 |
| `SMTP_ALLOW_LOCAL_PLAINTEXT` | Explicit `true` only for a loopback development mail catcher |

Use `NODE_ENV=development` for local plaintext. Never disable TLS verification
for production. STARTTLS never silently falls back to plaintext. Keep
`PUBLIC_APP_URL` at the application origin, without credentials, query, or
fragment. This service is hosted at the origin root, not a URL subdirectory.

Configure sender-domain authentication (SPF/DKIM and an appropriate DMARC
policy) with your mail operator. SMTP configuration and domain setup do not
guarantee inbox placement. Check your relay's sending limits before enabling
high-volume run notifications; providers may charge for usage.

Open **Admin → Notifications** to inspect configuration readiness and rendered
template samples. **Send me a test email** queues one message to the signed-in
admin's verified address; it is limited to once per minute. Preview uses only
synthetic data and disables links. Templates are reusable React components in
`src/notifications/templates.tsx`, rendered by the server; layout/copy changes
are code changes. There is no visual template editor.

## Account actions

**Forgot password?** on sign-in requests a reset link valid for 30 minutes.
The request response does not disclose whether an account exists. Completion
revokes all of that user's sessions and personal access tokens. Organisation
tokens are unchanged. Verification links last 24 hours.

Organisation members who can manage membership can issue invitations in the
organisation's Members card. Invitations last seven days. Resend supersedes
the previous link; Revoke closes it. New users create an ordinary account;
existing users must sign in to the invited account. Invitations never grant
platform-admin privileges.

Links keep action tokens in the URL fragment and remove it from visible history
when the form loads. Reloading after that requires reopening the original email.
Inspecting a link does not consume it; only explicit form submission does.

## Reliability and privacy

Messages are persisted in an encrypted SQLite outbox. The application records
only token hashes in account-action records and erases recoverable queued
payloads after acceptance, cancellation, expiry, or final failure. Keep
`TOKEN_ENCRYPTION_KEY` available across restarts; changing it makes existing
encrypted queued messages unreadable. Never inspect production action payloads
through logs or delivery-history endpoints.

Transient failures retry with exponential backoff starting at 30 seconds, up
to five attempts. Account-action mail takes priority. Optional messages expire
after 24 hours. Delivery history is retained for 30 days independently of job
artifacts. Membership, account activity, email verification, and preferences
are checked again before optional delivery.

**Accepted by mail server** means SMTP accepted the message, not that it reached
the inbox. Generic SMTP does not provide provider delivery/bounce webhooks. A
crash after SMTP acceptance but before recording it can produce a duplicate;
stable message identifiers help correlation but cannot promise exactly once.

Run emails include result counts and a bounded list of failed flow names,
without logs, attachments, or flow environment values. Run links require login
and organisation membership. A run removed by retention is unavailable.

## Release verification record

Automated tests exercise rendering, template escaping, MIME inputs, SMTP
security, persistence, replay/expiry, authorisation, and health transitions.
These do not substitute for real-client rendering checks.

Gmail, Outlook, and Apple Mail visual checks are **not yet performed**. Browser
discovery in this development session returned no available browser. No live
external test email was sent. Complete these visual checks before claiming
email-client compatibility or accepting the visual release criteria.
