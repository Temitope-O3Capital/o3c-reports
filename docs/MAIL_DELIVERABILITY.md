# Mail Deliverability and Tracking

## Sending Modes

- Campaign, reset-password, and notification mail use SendGrid.
- One-to-one staff mail can use Microsoft Graph when configured. Graph sends as the staff mailbox and saves the message to Sent Items.
- If Graph is not configured, one-to-one mail falls back to SendGrid and can copy the sender by BCC.

## Required SendGrid Setup

1. Authenticate the sending domain in SendGrid.
2. Add all DNS records SendGrid provides for SPF, DKIM, and DMARC.
   Current required fix for `o3cards.com`: the public SPF record only includes Microsoft 365. Add SendGrid to the single SPF record, for example:
   `v=spf1 include:spf.protection.outlook.com include:sendgrid.net -all`
3. Add the two SendGrid DKIM CNAME records shown in SendGrid domain authentication. For SendGrid's common selectors these are `s1._domainkey.o3cards.com` and `s2._domainkey.o3cards.com`, but use the exact host/value SendGrid gives you.
4. Keep only one SPF TXT record at `o3cards.com`. Multiple SPF records can fail authentication.
5. Do not enforce `p=quarantine` or `p=reject` for SendGrid traffic until SPF/DKIM pass. During setup, use `p=none`; move back to quarantine after test messages authenticate.
6. Enable link branding so tracked links use the O3C domain rather than a generic SendGrid domain.
7. Use a real sender such as `care@o3cards.com` or `support@o3cards.com`; do not send from free-mail domains.
8. Configure the Event Webhook URL:
   `/api/campaign-webhooks/email-webhook`
9. Enable Signed Event Webhook and store the public key as `SENDGRID_WEBHOOK_PUBLIC_KEY`.
10. Keep `EMAIL_WEBHOOK_SECRET` only as a development fallback.

## Microsoft Graph Setup

Create an Entra app registration with Microsoft Graph `Mail.Send` application permission and admin consent.

Set these values in environment variables or the Admin API Keys screen:

- `MS_GRAPH_TENANT_ID`
- `MS_GRAPH_CLIENT_ID`
- `MS_GRAPH_CLIENT_SECRET`

The app sends via:

`POST https://graph.microsoft.com/v1.0/users/{staffEmail}/sendMail`

Graph saves to Sent Items by default.

## Campaign Hygiene

- Start with small volumes and warm up gradually.
- Use `campaign_daily_email_limit` to cap daily campaign mail while warming up.
- Use `campaign_send_delay_ms` to slow provider calls between recipients.
- Do not send to old, purchased, or unverified lists.
- Keep bounce, spam-report, dropped, and unsubscribe events suppressed. The app stores these in `mail_suppressions` and skips them on future sends.
- Include a clear sender identity, physical business identity, and unsubscribe language in marketing campaigns.
- Avoid URL shorteners, image-only emails, spammy punctuation, misleading subject lines, and large attachments.
- Segment campaigns rather than sending every message to every contact.

## Platform Checks

Admin users can open Admin > Mail Health to see:

- SendGrid API key presence
- signed webhook key presence
- Microsoft Graph readiness
- SPF TXT lookup
- DMARC TXT lookup
- active suppression count
- tracked mail status metrics

Set `mail_domain` in Platform Settings if the sending domain cannot be inferred from `SENDGRID_FROM_EMAIL`.
Set `app_base_url` so campaign unsubscribe links are generated correctly.

## Tracking

The app stores outbound mail in `mail_messages` and provider events in `mail_events`.

Tracked states include:

- queued
- processed
- delivered
- deferred
- opened
- clicked
- bounced
- dropped
- spam_report
- unsubscribed
- failed

Open and click metrics are directional, not perfect. Some clients block pixels, proxy opens, or prefetch links.
