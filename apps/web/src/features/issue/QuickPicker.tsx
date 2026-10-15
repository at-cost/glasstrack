import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Issue, IssueDetail } from "@glasstrack/shared";
import { Dialog } from "../../components/Dialog";
import { Spinner } from "../../components/Feedback";
import { OptionList } from "../../components/Picker";
import { api } from "../../lib/api";
import { useUpdateIssue } from "../../lib/mutations";
import { keys, useLabels, useMembers, useStates } from "../../lib/queries";
import type { PickerKind } from "../../lib/store";
import { useWs } from "../shell/context";
import { assigneeOptions, labelOptions, patchFor, priorityOptions, selectedFor, statusOptions } from "./options";

/** Finds an issue by id in any cached list or detail. */
export function findCachedIssue(qc: QueryClient, slug: string, id: string): Issue | undefined {
  for (const [, d] of qc.getQueriesData<IssueDetail>({ queryKey: keys.issueAll(slug) })) {
    if (d?.id === id) return d;
  }
  for (const [, d] of qc.getQueriesData<{ issues: Issue[] }>({ queryKey: keys.issuesAll(slug) })) {
    const hit = d?.issues.find((i) => i.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/** Finds the freshest copy of an issue: cache first, server as fallback. */
export function useIssueById(slug: string, id: string) {
  const qc = useQueryClient();
  const cached = id ? findCachedIssue(qc, slug, id) : undefined;
  const q = useQuery({
    queryKey: keys.issue(slug, id),
    queryFn: () => api.ws(slug).issue(id),
    enabled: !cached && Boolean(id) && !id.startsWith("temp-"),
  });
  return cached ?? q.data;
}

const TITLES: Record<PickerKind, string> = {
  status: "Change status",
  assignee: "Assignees",
  priority: "Set priority",
  labels: "Edit labels",
};

export function QuickPicker({ kind, issueRef, onClose }: { kind: PickerKind; issueRef: string; onClose: () => void }) {
  const { slug, me } = useWs();
  const issue = useIssueById(slug, issueRef);
  const states = useStates(slug);
  const members = useMembers(slug);
  const labels = useLabels(slug);
  const update = useUpdateIssue(slug);
  const qc = useQueryClient();

  const options =
    issue &&
    (kind === "status"
      ? statusOptions(states.data, issue.teamId)
      : kind === "priority"
        ? priorityOptions()
        : kind === "assignee"
          ? assigneeOptions(members.data, me.id)
          : labelOptions(labels.data, issue.teamId));

  return (
    <Dialog title={issue ? `${TITLES[kind]}: ${issue.identifier}` : TITLES[kind]} onClose={onClose} size="sm" className="picker-dialog">
      {!issue || !options ? (
        <Spinner />
      ) : (
        <OptionList
          label={TITLES[kind]}
          placeholder={`${TITLES[kind]}...`}
          options={options}
          selected={selectedFor(kind, issue)}
          multi={kind === "labels" || kind === "assignee"}
          onPick={(id) => {
            // Read the latest cached copy so repeated toggles stack up.
            const fresh = findCachedIssue(qc, slug, issue.id) ?? issue;
            update.mutate({ issue: fresh, patch: patchFor(kind, fresh, id) });
          }}
          onClose={onClose}
          emptyText={kind === "labels" ? "No labels yet. Add them in Settings." : "No matches"}
        />
      )}
    </Dialog>
  );
}
