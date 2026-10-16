/** @jsxImportSource hono/jsx */
import { Layout, type PageMeta, type SiteCtx } from "../layout";

export const statusMeta: PageMeta = {
  path: "/status",
  title: "Status | Glasstrack",
  description: "Whether this Glasstrack server and its database are up right now.",
  og: "status",
};

export interface StatusInfo {
  databaseOk: boolean;
  version: string;
  commit: string;
  uptimeSeconds: number;
  checkedAt: string;
  statusPageUrl: string;
}

function duration(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} day${d === 1 ? "" : "s"}, ${h} hour${h === 1 ? "" : "s"}`;
  if (h > 0) return `${h} hour${h === 1 ? "" : "s"}, ${m} minute${m === 1 ? "" : "s"}`;
  return `${m} minute${m === 1 ? "" : "s"}`;
}

export function StatusPage(p: { status: StatusInfo; site: SiteCtx }) {
  const s = p.status;
  return (
    <Layout meta={statusMeta} site={p.site}>
      <div class="wrap">
        <header class="page-head">
          <p class="eyebrow">Status</p>
          <h1>{s.databaseOk ? "Everything is working" : "The database can't be reached"}</h1>
          {s.statusPageUrl ? (
            <p class="lede">
              Incidents and history are on the <a href={s.statusPageUrl}>status page</a>.
            </p>
          ) : (
            <p class="lede">A live check of this server, made when you loaded the page.</p>
          )}
        </header>
        <div style="max-width:36rem;padding-bottom:40px">
          <table class="ledger">
            <tbody>
              <tr>
                <th scope="row">Web server</th>
                <td class="r">Up</td>
              </tr>
              <tr>
                <th scope="row">Database</th>
                <td class="r">{s.databaseOk ? "Reachable" : "Not reachable"}</td>
              </tr>
              <tr>
                <th scope="row">Version</th>
                <td class="r">
                  {s.version}
                  {s.commit ? ` (${s.commit})` : ""}
                </td>
              </tr>
              <tr>
                <th scope="row">This process has been running for</th>
                <td class="r">{duration(s.uptimeSeconds)}</td>
              </tr>
              <tr>
                <th scope="row">Checked</th>
                <td class="r">{s.checkedAt.slice(0, 19).replace("T", " ")} UTC</td>
              </tr>
            </tbody>
          </table>
          <p class="small muted" style="margin-top:14px">
            Machine-readable checks: <a href="/health">/health</a> and <a href="/ready">/ready</a>.
          </p>
        </div>
      </div>
    </Layout>
  );
}
