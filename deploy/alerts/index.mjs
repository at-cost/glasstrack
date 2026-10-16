// Glasstrack alerting (AWS Lambda, Node.js 22). Three jobs:
//  - {"mode":"health"} every 5 minutes: is the site up? Records Glasstrack/HealthOk (1 or 0).
//  - {"mode":"disk"} every hour: records Glasstrack/DiskUsedPercent from the server.
//  - SNS messages (CloudWatch alarms, budget alerts): a read-only diagnostic of the
//    server, sent to the operator on Telegram; then, optionally, an "incident"
//    dispatch to GitHub so the AI maintainer takes a first pass. GitHub gets only
//    numbers and container states (Actions logs are public), never log lines.
// Nothing here changes the server: the diagnostic is a fixed, read-only script.
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { GetCommandInvocationCommand, SendCommandCommand, SSMClient } from "@aws-sdk/client-ssm";

const env = process.env;
const cw = new CloudWatchClient({});
const ssm = new SSMClient({});

const DIAGNOSTIC = `set +e
cd ${env.COMPOSE_DIR || "/srv/glasstrack/src"}
C="docker compose -f docker-compose.yml -f deploy/docker-compose.cloudflare.yml"
echo "== containers"; $C ps --format '{{.Service}} {{.State}} {{.Status}}'
echo "== health"; curl -sk -o /dev/null -w '%{http_code}\\n' -m 8 --resolve ${env.SITE_HOST || "glasstrack.dev"}:443:127.0.0.1 https://${env.SITE_HOST || "glasstrack.dev"}/health
echo "== disk"; df --output=pcent / | tail -1
echo "== memory_free_mb"; free -m | awk '/^Mem:/ {print $7}'
echo "== load"; cut -d' ' -f1-3 /proc/loadavg
echo "== app log"; $C logs --tail 40 --no-color app 2>&1 | cut -c1-300`;

async function telegram(text) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ chat_id: env.TELEGRAM_CHAT_ID, text: text.slice(0, 4000), disable_web_page_preview: "true" }),
  });
}

async function metric(name, value) {
  await cw.send(new PutMetricDataCommand({ Namespace: "Glasstrack", MetricData: [{ MetricName: name, Value: value, Unit: name.endsWith("Percent") ? "Percent" : "Count" }] }));
}

async function runOnServer(script, waitMs = 45_000) {
  const sent = await ssm.send(new SendCommandCommand({
    InstanceIds: [env.INSTANCE_ID], DocumentName: "AWS-RunShellScript", Parameters: { commands: [script] }, TimeoutSeconds: 60,
    Comment: "Glasstrack read-only diagnostic",
  }));
  const id = sent.Command.CommandId;
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const r = await ssm.send(new GetCommandInvocationCommand({ CommandId: id, InstanceId: env.INSTANCE_ID }));
      if (!["Pending", "InProgress", "Delayed"].includes(r.Status)) return r.StandardOutputContent || r.StandardErrorContent || `(${r.Status})`;
    } catch (e) {
      if (e.name !== "InvocationDoesNotExist") throw e;
    }
  }
  return "(diagnostic timed out)";
}

/** Numbers and states only, safe to put in public logs. */
function summarise(diag) {
  const section = (name) => (diag.split(`== ${name}`)[1] ?? "").split("\n== ")[0].trim();
  return {
    containers: section("containers").split("\n").filter(Boolean).map((l) => l.split(" ").slice(0, 2).join(" ")),
    health_http: section("health").split("\n")[0] || "unknown",
    disk_used: section("disk").trim(),
    memory_free_mb: section("memory_free_mb"),
    load: section("load"),
  };
}

async function health() {
  let ok = 0;
  for (let i = 0; i < 2 && !ok; i++) {
    try {
      const r = await fetch(env.HEALTH_URL, { signal: AbortSignal.timeout(10_000), headers: { "user-agent": "glasstrack-healthcheck" } });
      ok = r.ok ? 1 : 0;
    } catch {
      ok = 0;
    }
  }
  await metric("HealthOk", ok);
  return { ok };
}

async function disk() {
  const out = await runOnServer("df --output=pcent / | tail -1 | tr -dc '0-9'", 30_000);
  const pct = Number(out.trim());
  if (Number.isFinite(pct) && out.trim() !== "") await metric("DiskUsedPercent", pct);
  return { pct };
}

async function onAlert(subject, message) {
  let alarm = null;
  try {
    alarm = JSON.parse(message);
  } catch {
    // Budget alerts and other plain-text notifications.
  }
  if (!alarm?.AlarmName) {
    await telegram(`Glasstrack: ${subject || "AWS notification"}\n\n${message}`);
    return;
  }
  if (alarm.NewStateValue === "OK") {
    await telegram(`Glasstrack resolved: ${alarm.AlarmName}\n${alarm.NewStateReason ?? ""}`);
    return;
  }
  let diag = "";
  try {
    diag = await runOnServer(DIAGNOSTIC);
  } catch (e) {
    diag = `(could not run the diagnostic: ${e.message})`;
  }
  await telegram(`Glasstrack ALERT: ${alarm.AlarmName}\n${alarm.NewStateReason ?? ""}\n\n${diag}`);
  if (env.GITHUB_TOKEN && env.GITHUB_REPO) {
    const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "glasstrack-alerts" },
      body: JSON.stringify({ event_type: "incident", client_payload: { alarm: alarm.AlarmName, state: alarm.NewStateValue, reason: (alarm.NewStateReason ?? "").slice(0, 300), server: summarise(diag) } }),
    });
    if (!r.ok) await telegram(`(Could not start the AI first pass: GitHub returned ${r.status})`);
  }
}

export async function handler(event) {
  if (event?.mode === "health") return health();
  if (event?.mode === "disk") return disk();
  for (const rec of event?.Records ?? []) {
    if (rec.Sns) await onAlert(rec.Sns.Subject, rec.Sns.Message);
  }
  return { ok: true };
}
