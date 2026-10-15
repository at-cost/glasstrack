import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { GitIntegration, GitProvider } from "@glasstrack/shared";
import { type ReactNode, useState } from "react";
import { Card } from "../../components/Card";
import { CopyField } from "../../components/CopyField";
import { ConfirmDialog } from "../../components/Dialog";
import { Empty, Skeleton } from "../../components/Feedback";
import { api, errorMessage } from "../../lib/api";
import { keys } from "../../lib/queries";
import { toast, toastError } from "../../lib/toast";
import { useWs } from "../shell/context";

interface ForgeText {
  name: string;
  /** What the host calls a change: "merge request" or "pull request". */
  change: string;
  intro: ReactNode;
  steps: (g: GitIntegration & { secret: string }) => ReactNode;
  repeat: string;
}

const FORGES: Record<GitProvider, ForgeText> = {
  gitlab: {
    name: "GitLab",
    change: "merge request",
    intro: (
      <>
        Mention an issue key like <span className="mono">ENG-12</span> in a merge request's title, description or branch name. The merge
        request shows up on the issue, and when it is merged the issue can move to Done. Works with GitLab.com and self-managed GitLab.
      </>
    ),
    steps: (g) => (
      <>
        <li>In your project on GitLab, open Settings, then Webhooks, then Add new webhook.</li>
        <li>
          <CopyField label="URL" value={g.webhookUrl} />
        </li>
        <li>
          <CopyField label="Secret token" value={g.secret} secret />
        </li>
        <li>Under Trigger, tick only "Merge request events".</li>
        <li>Save. You can use Test, then "Merge request events", to check it.</li>
      </>
    ),
    repeat: "Repeat for each project, or add it once on a group. They can all use the same URL and secret token.",
  },
  gitea: {
    name: "Gitea and Forgejo",
    change: "pull request",
    intro: (
      <>
        Mention an issue key like <span className="mono">ENG-12</span> in a pull request's title, description or branch name. The pull
        request shows up on the issue, and when it is merged the issue can move to Done. Works with Gitea, Forgejo and Codeberg.
      </>
    ),
    steps: (g) => (
      <>
        <li>In your repository, open Settings, then Webhooks, then Add webhook, and pick Gitea (or Forgejo).</li>
        <li>
          <CopyField label="Target URL" value={g.webhookUrl} />
        </li>
        <li>
          Set the content type to <span className="mono">application/json</span>.
        </li>
        <li>
          <CopyField label="Secret" value={g.secret} secret />
        </li>
        <li>Under Trigger on, pick "Custom events" and tick only "Pull request".</li>
        <li>Add the webhook. You can use Test delivery to check it.</li>
      </>
    ),
    repeat: "Repeat for each repository, or add it once on an organization. They can all use the same URL and secret.",
  },
};

/** GitLab or Gitea/Forgejo webhook settings. Same flow as the GitHub tab. */
export function GitForge({ provider }: { provider: GitProvider }) {
  const { slug, isAdmin, canEdit } = useWs();
  const qc = useQueryClient();
  const text = FORGES[provider];
  const key = keys.gitForge(slug, provider);
  const q = useQuery({ queryKey: key, queryFn: () => api.ws(slug).gitForge(provider), enabled: isAdmin });
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"rotate" | "disable" | null>(null);

  if (!isAdmin) {
    return (
      <Card title={text.name}>
        <p className="muted">Only admins can set up the {text.name} integration.</p>
      </Card>
    );
  }
  if (q.isPending) return <Skeleton rows={3} />;
  if (q.error) return <Empty title="Could not load the integration">{errorMessage(q.error)}</Empty>;
  const g = q.data;

  const save = async (b: { moveOnMerge: boolean; rotateSecret?: boolean }, msg: string) => {
    setBusy(true);
    try {
      const next = await api.ws(slug).saveGitForge(provider, b);
      qc.setQueryData<GitIntegration>(key, next);
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
      await api.ws(slug).disableGitForge(provider);
      await qc.invalidateQueries({ queryKey: key });
      toast(`${text.name} integration turned off`, "success");
    } catch (err) {
      toastError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card title={`${text.name} ${text.change}s`}>
        <p className="small">{text.intro}</p>
        {!g.enabled ? (
          <div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !canEdit}
              onClick={() => save({ moveOnMerge: true }, `${text.name} integration is on`)}
            >
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
              Move issues to Done when merged
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
        <Card title={`Set up the webhook in ${text.name}`}>
          <ol className="steps">{text.steps({ ...g, secret: g.secret })}</ol>
          <p className="muted small">{text.repeat}</p>
        </Card>
      )}
      {confirm === "rotate" && (
        <ConfirmDialog
          title="Create a new secret?"
          message={`The old secret stops working right away. Update it in every webhook you set up in ${text.name}.`}
          confirmLabel="Create new secret"
          onConfirm={() => save({ moveOnMerge: g.moveOnMerge ?? true, rotateSecret: true }, "New secret created")}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === "disable" && (
        <ConfirmDialog
          title={`Turn off ${text.name}?`}
          message={`New ${text.change}s stop linking. Links already on issues stay. Turning it on again creates a new secret.`}
          confirmLabel="Turn off"
          danger
          onConfirm={disable}
          onClose={() => setConfirm(null)}
        />
      )}
    </>
  );
}
