import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Card } from "../../components/Card";
import { CopyField } from "../../components/CopyField";
import { ConfirmDialog } from "../../components/Dialog";
import { Empty, Skeleton } from "../../components/Feedback";
import { api, errorMessage, type GithubIntegration } from "../../lib/api";
import { keys } from "../../lib/queries";
import { toast, toastError } from "../../lib/toast";
import { useWs } from "../shell/context";

export function GitHub() {
  const { slug, isAdmin, canEdit } = useWs();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: keys.github(slug), queryFn: () => api.ws(slug).github(), enabled: isAdmin });
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"rotate" | "disable" | null>(null);

  if (!isAdmin) {
    return (
      <Card title="GitHub">
        <p className="muted">Only admins can set up the GitHub integration.</p>
      </Card>
    );
  }
  if (q.isPending) return <Skeleton rows={3} />;
  if (q.error) return <Empty title="Could not load the integration">{errorMessage(q.error)}</Empty>;
  const g = q.data;

  const save = async (b: { moveOnMerge: boolean; rotateSecret?: boolean }, msg: string) => {
    setBusy(true);
    try {
      const next = await api.ws(slug).saveGithub(b);
      qc.setQueryData<GithubIntegration>(keys.github(slug), next);
      toast(msg, "success");
    } catch (err) {
      toastError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const disable = async () => {
    setBusy(true);
    try {
      await api.ws(slug).disableGithub();
      await qc.invalidateQueries({ queryKey: keys.github(slug) });
      toast("GitHub integration turned off", "success");
    } catch (err) {
      toastError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card title="GitHub pull requests">
        <p className="small">
          Mention an issue key like <span className="mono">ENG-12</span> in a pull request's title, description or branch name. The pull
          request shows up on the issue, and when it is merged the issue can move to Done.
        </p>
        {!g.enabled ? (
          <div>
            <button type="button" className="btn btn-primary" disabled={busy || !canEdit} onClick={() => save({ moveOnMerge: true }, "GitHub integration is on")}>
              Turn on
            </button>
          </div>
        ) : (
          <>
            <label className="check-row">
              <input
                type="checkbox"
                checked={g.moveOnMerge ?? true}
                disabled={busy || !canEdit}
                onChange={(e) => save({ moveOnMerge: e.target.checked }, "Saved")}
              />
              Move the issue to Done when its pull request is merged
            </label>
            <div className="row wrap">
              <button type="button" className="btn btn-sm" disabled={busy || !canEdit} onClick={() => setConfirm("rotate")}>
                New secret
              </button>
              <button type="button" className="btn btn-sm btn-ghost" disabled={busy || !canEdit} onClick={() => setConfirm("disable")}>
                Turn off
              </button>
            </div>
          </>
        )}
      </Card>
      {g.enabled && g.secret && (
        <Card title="Set up the webhook in GitHub">
          <ol className="steps">
            <li>In your repository on GitHub, open Settings, then Webhooks, then Add webhook.</li>
            <li>
              <CopyField label="Payload URL" value={g.webhookUrl} />
            </li>
            <li>
              Set Content type to <span className="mono">application/json</span>.
            </li>
            <li>
              <CopyField label="Secret" value={g.secret} secret />
            </li>
            <li>Under "Which events", pick "Let me select individual events" and tick only "Pull requests".</li>
            <li>Save. GitHub sends a test ping, which should show a green check.</li>
          </ol>
          <p className="muted small">Repeat for each repository. They can all use the same URL and secret.</p>
        </Card>
      )}
      {confirm === "rotate" && (
        <ConfirmDialog
          title="Create a new secret?"
          message="The old secret stops working right away. Update it in every repository's webhook settings."
          confirmLabel="Create new secret"
          onConfirm={() => save({ moveOnMerge: g.moveOnMerge ?? true, rotateSecret: true }, "New secret created")}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === "disable" && (
        <ConfirmDialog
          title="Turn off GitHub?"
          message="New pull requests stop linking. Links already on issues stay. Turning it on again creates a new secret."
          confirmLabel="Turn off"
          danger
          onConfirm={disable}
          onClose={() => setConfirm(null)}
        />
      )}
    </>
  );
}
