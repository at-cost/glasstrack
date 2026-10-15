/**
 * Cloudflare Email Worker for Glasstrack email-to-issue.
 *
 * Route every address on your inbound domain (e.g. *@in.example.com) to this
 * worker. It forwards the raw message to Glasstrack. Set two worker variables:
 *   GLASSTRACK_URL     e.g. https://tracker.example.com
 *   INBOUND_SECRET     the same value as INBOUND_EMAIL_SECRET on the server (store it as a secret)
 */
export default {
  async email(message, env) {
    const res = await fetch(`${env.GLASSTRACK_URL}/api/v1/inbound/email?to=${encodeURIComponent(message.to)}`, {
      method: "POST",
      headers: { "content-type": "message/rfc822", "x-glasstrack-inbound-secret": env.INBOUND_SECRET },
      body: message.raw,
    });
    if (res.status === 404) message.setReject("No such inbox");
    else if (!res.ok) throw new Error(`Glasstrack returned ${res.status}`); // Cloudflare retries later
  },
};
