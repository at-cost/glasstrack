import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { Team } from "@tracker/shared";
import { useEffect, useRef } from "react";
import { Dialog } from "../../components/Dialog";
import { Kbd } from "../../components/icons";
import { paths } from "../../lib/paths";
import { keys } from "../../lib/queries";
import { currentIssueStore, type PickerKind, ui, uiStore } from "../../lib/store";
import { useWs } from "../shell/context";

export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el?.tagName) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color"].includes(type);
  }
  return el.isContentEditable;
}

function modalOpen(): boolean {
  return Boolean(document.querySelector('[aria-modal="true"]'));
}

export function useGlobalShortcuts() {
  const { slug, canEdit } = useWs();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { teamKey?: string };
  const qc = useQueryClient();
  const gAt = useRef(0);
  const teamKeyRef = useRef(params.teamKey);
  teamKeyRef.current = params.teamKey;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const s = uiStore.get();
        if (s.paletteOpen) ui.closePalette();
        else if (!modalOpen()) ui.openPalette();
        return;
      }
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target) || modalOpen()) return;
      const key = e.key;
      const now = Date.now();
      if (now - gAt.current < 1200) {
        gAt.current = 0;
        if (key === "i") {
          e.preventDefault();
          navigate({ to: paths.inbox(slug) });
          return;
        }
        if (key === "m") {
          e.preventDefault();
          navigate({ to: paths.myIssues(slug) });
          return;
        }
      }
      switch (key) {
        case "g":
          gAt.current = now;
          return;
        case "c": {
          if (!canEdit) return;
          e.preventDefault();
          const teams = qc.getQueryData<Team[]>(keys.teams(slug));
          const team = teams?.find((t) => t.key === teamKeyRef.current);
          ui.openCreate(team ? { teamId: team.id } : {});
          return;
        }
        case "/": {
          e.preventDefault();
          const input = document.querySelector<HTMLInputElement>("[data-search-input]");
          if (input) input.focus();
          else ui.openPalette();
          return;
        }
        case "?":
          e.preventDefault();
          ui.openHelp();
          return;
        case "s":
        case "a":
        case "p":
        case "l": {
          const ref = currentIssueStore.get();
          if (!ref || !canEdit) return;
          e.preventDefault();
          const kind: PickerKind = key === "s" ? "status" : key === "a" ? "assignee" : key === "p" ? "priority" : "labels";
          ui.openPicker(kind, ref);
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slug, navigate, qc, canEdit]);
}

const SHORTCUTS: [string[], string][] = [
  [["Ctrl", "K"], "Open the command menu (Cmd K on Mac)"],
  [["c"], "Create an issue"],
  [["/"], "Search or filter"],
  [["g", "i"], "Go to inbox"],
  [["g", "m"], "Go to my issues"],
  [["j"], "Next issue in a list"],
  [["k"], "Previous issue in a list"],
  [["Enter"], "Open the focused issue"],
  [["s"], "Change status"],
  [["a"], "Assign"],
  [["p"], "Set priority"],
  [["l"], "Edit labels"],
  [["Space"], "Pick up or drop a board card, then use arrow keys"],
  [["Ctrl", "Enter"], "Submit a form or comment"],
  [["?"], "Show this list"],
];

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} size="sm">
      <p className="muted small">Shortcuts are off while you type in a field. Issue shortcuts act on the focused or open issue.</p>
      <table className="shortcut-table">
        <tbody>
          {SHORTCUTS.map(([k, label]) => (
            <tr key={label}>
              <td>
                {k.map((x, i) => (
                  <span key={x}>
                    {i > 0 && <span className="muted">{k[0] === "Ctrl" ? " + " : " then "}</span>}
                    <Kbd>{x}</Kbd>
                  </span>
                ))}
              </td>
              <td>{label}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}
