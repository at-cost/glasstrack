import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, CircleUser, Inbox, Keyboard, Moon, Plus, Settings } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Dialog } from "../../components/Dialog";
import { StatusIcon } from "../../components/icons";
import { OptionList, type Option } from "../../components/Picker";
import { api } from "../../lib/api";
import { fuzzyFilter } from "../../lib/fuzzy";
import { paths } from "../../lib/paths";
import { useStates, useTeams, useViews } from "../../lib/queries";
import { currentIssueStore, type PickerKind, ui } from "../../lib/store";
import { toggleTheme } from "../../lib/theme";
import { useIssueById } from "../issue/QuickPicker";
import { useWs } from "../shell/context";

interface Action extends Option {
  run: () => void;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { slug, canEdit } = useWs();
  const navigate = useNavigate();
  const teams = useTeams(slug);
  const views = useViews(slug);
  const states = useStates(slug);
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query.trim(), 180);
  const search = useQuery({
    queryKey: ["search", slug, debounced],
    queryFn: () => api.ws(slug).search(debounced),
    enabled: debounced.length > 0,
    staleTime: 10_000,
  });
  const currentRef = currentIssueStore.get();
  const current = useIssueById(slug, currentRef ?? "");

  const actions = useMemo<Action[]>(() => {
    const go = (to: string) => () => navigate({ to });
    const icon = (n: ReactNode) => n;
    const list: Action[] = [];
    if (current && currentRef && canEdit) {
      const pick = (kind: PickerKind) => () => ui.openPicker(kind, currentRef);
      const g = `Issue ${current.identifier}`;
      list.push(
        { id: "i-status", label: "Change status", hint: "s", group: g, icon: icon(<ArrowRight size={14} />), run: pick("status") },
        { id: "i-assign", label: "Assign", hint: "a", group: g, icon: icon(<CircleUser size={14} />), run: pick("assignee") },
        { id: "i-prio", label: "Set priority", hint: "p", group: g, icon: icon(<ArrowRight size={14} />), run: pick("priority") },
        { id: "i-labels", label: "Edit labels", hint: "l", group: g, icon: icon(<ArrowRight size={14} />), run: pick("labels") },
      );
    }
    if (canEdit)
      list.push({ id: "create", label: "Create issue", hint: "c", group: "Actions", icon: <Plus size={14} />, run: () => ui.openCreate() });
    list.push(
      { id: "inbox", label: "Go to inbox", hint: "g i", group: "Actions", icon: <Inbox size={14} />, run: go(paths.inbox(slug)) },
      { id: "my", label: "Go to my issues", hint: "g m", group: "Actions", icon: <CircleUser size={14} />, run: go(paths.myIssues(slug)) },
      { id: "settings", label: "Go to settings", group: "Actions", icon: <Settings size={14} />, run: go(paths.settings(slug)) },
      { id: "theme", label: "Toggle theme", group: "Actions", icon: <Moon size={14} />, run: toggleTheme },
      { id: "help", label: "Keyboard shortcuts", hint: "?", group: "Actions", icon: <Keyboard size={14} />, run: ui.openHelp },
    );
    for (const t of teams.data ?? []) {
      const g = "Teams";
      list.push(
        { id: `t-${t.id}-i`, label: `${t.name}: Issues`, group: g, keywords: t.key, run: go(paths.teamIssues(slug, t.key)) },
        { id: `t-${t.id}-b`, label: `${t.name}: Board`, group: g, keywords: t.key, run: go(paths.teamBoard(slug, t.key)) },
        { id: `t-${t.id}-bl`, label: `${t.name}: Backlog`, group: g, keywords: t.key, run: go(paths.teamBacklog(slug, t.key)) },
        { id: `t-${t.id}-c`, label: `${t.name}: Cycles`, group: g, keywords: t.key, run: go(paths.teamCycles(slug, t.key)) },
      );
    }
    for (const v of views.data ?? []) {
      list.push({ id: `v-${v.id}`, label: v.name, group: "Views", run: go(paths.view(slug, v.id)) });
    }
    return list;
  }, [current, currentRef, canEdit, teams.data, views.data, slug, navigate]);

  const issueItems = useMemo<Action[]>(
    () =>
      (debounced ? (search.data?.issues ?? []) : []).map((i) => ({
        id: `issue-${i.id}`,
        label: i.title,
        hint: i.identifier,
        group: "Issues",
        icon: <StatusIcon state={states.data?.find((s) => s.id === i.statusId)} />,
        run: () => navigate({ to: paths.issue(slug, i.identifier) }),
      })),
    [search.data, debounced, states.data, slug, navigate],
  );

  const shown = useMemo(() => {
    const matched = fuzzyFilter(actions, query, (a) => `${a.label} ${a.keywords ?? ""} ${a.group ?? ""}`);
    // Keep groups together: issue actions first, then issues found, then the rest.
    const issueActs = matched.filter((a) => a.id.startsWith("i-"));
    const rest = matched.filter((a) => !a.id.startsWith("i-"));
    return query.trim() ? [...issueActs, ...issueItems, ...rest] : [...issueActs, ...rest];
  }, [actions, issueItems, query]);

  const byId = new Map(shown.map((a) => [a.id, a]));
  return (
    <Dialog title="Command menu" onClose={onClose} hideTitle size="md" className="palette">
      <OptionList
        label="Type a command or search issues"
        placeholder="Type a command or search issues..."
        options={shown}
        filter={false}
        query={query}
        onQueryChange={setQuery}
        onPick={(id) => {
          const a = byId.get(id);
          onClose();
          // Let the palette unmount before opening another dialog.
          if (a) setTimeout(a.run, 0);
        }}
        onClose={onClose}
        emptyText={search.isFetching ? "Searching..." : "Nothing found"}
      />
    </Dialog>
  );
}
