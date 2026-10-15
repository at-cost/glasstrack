# Email to issue

Each email inbox (Settings, Requests) gets an address like `in-k3j9x2@in.example.com`. Mail sent there becomes an issue in the inbox's team. Replies to the same thread become comments. Attachments (up to 10 files, 10 MB each) are kept.

Glasstrack doesn't run a mail server. A forwarder posts each raw message to Glasstrack:

```
POST /api/v1/inbound/email?to=<recipient address>
Content-Type: message/rfc822
X-Glasstrack-Inbound-Secret: <INBOUND_EMAIL_SECRET>

<the raw email>
```

Responses: `201` issue created, `200` comment added or mail ignored (automatic replies, bulk mail, non-members when the inbox is members-only), `404` no such inbox (reject the mail), `401` wrong secret.

## Setup

1. Pick a domain or subdomain for inbound mail, e.g. `in.example.com`.
2. Set on the server: `INBOUND_EMAIL_DOMAIN=in.example.com` and a long random `INBOUND_EMAIL_SECRET`.
3. Forward that domain's mail to the endpoint. Any forwarder works. With Cloudflare Email Routing:
   - Enable Email Routing for the domain (it adds the MX records).
   - Create a Worker from `deploy/cloudflare-email-worker.js` with the variables `GLASSTRACK_URL` and `INBOUND_SECRET`.
   - Add a catch-all rule for the domain that sends to the Worker.

Other options: Amazon SES receipt rules (S3 + a small Lambda that does the same POST), Postmark or Mailgun inbound webhooks with a small adapter, or your own Postfix pipe.

## Things to know

- The From address of an email can be forged. "Only members can send" filters on it, but isn't proof of identity, so issues from email are never credited to a member.
- Glasstrack never auto-replies to incoming mail, so it can't be used to send mail to someone else's address. The only email it sends to a requester is one note when their issue is done or closed, and you can turn that off per inbox.
