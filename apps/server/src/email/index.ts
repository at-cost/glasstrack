import { appendFile } from "node:fs/promises";
import nodemailer from "nodemailer";
import type { Config } from "../config";
import { logger } from "../lib/logger";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** For per-workspace email metering. */
  workspaceId?: string;
}

export interface Mailer {
  send(msg: EmailMessage): Promise<void>;
}

/**
 * One interface for every provider. AWS SES is used through its SMTP endpoint
 * (SMTP_URL=smtps://KEY:SECRET@email-smtp.<region>.amazonaws.com:465), so no
 * AWS SDK is needed. Without SMTP_URL, emails are logged (development);
 * SMTP_URL=file:///path/mail.jsonl appends them to a file (tests).
 */
export function createMailer(config: Config): Mailer {
  if (!config.SMTP_URL) {
    return {
      async send(msg) {
        logger.info({ email: { to: msg.to, subject: msg.subject }, text: msg.text }, "email (not sent: SMTP_URL unset)");
      },
    };
  }
  if (config.SMTP_URL.startsWith("file://")) {
    // Development and end-to-end tests: append each email as a JSON line.
    const file = config.SMTP_URL.slice("file://".length);
    return {
      async send(msg) {
        await appendFile(file, `${JSON.stringify({ to: msg.to, subject: msg.subject, text: msg.text, at: new Date().toISOString() })}\n`);
      },
    };
  }
  const transport = nodemailer.createTransport(config.SMTP_URL);
  return {
    async send(msg) {
      await transport.sendMail({ from: config.EMAIL_FROM, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
    },
  };
}

/** In-memory mailer for tests. */
export function createTestMailer(): Mailer & { outbox: EmailMessage[]; last(to: string): EmailMessage | undefined } {
  const outbox: EmailMessage[] = [];
  return {
    outbox,
    async send(msg) {
      outbox.push(msg);
    },
    last(to) {
      return [...outbox].reverse().find((m) => m.to === to);
    },
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Minimal shared layout: plain text first, simple HTML second. */
export function layout(title: string, paragraphs: string[], action?: { label: string; url: string }) {
  const text = [title, "", ...paragraphs, ...(action ? ["", `${action.label}: ${action.url}`] : [])].join("\n");
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:520px;margin:24px auto;color:#1b1d22">
<h2 style="font-size:18px">${esc(title)}</h2>
${paragraphs.map((p) => `<p style="line-height:1.5">${esc(p)}</p>`).join("\n")}
${action ? `<p><a href="${esc(action.url)}" style="display:inline-block;background:#2f5d50;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${esc(action.label)}</a></p>` : ""}
</body></html>`;
  return { text, html };
}
