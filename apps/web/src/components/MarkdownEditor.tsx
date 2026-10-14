import type { Member } from "@tracker/shared";
import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "../lib/markdown";
import { Avatar } from "./icons";

export function Markdown({ source, className = "" }: { source: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown sanitizes with DOMPurify
  return <div className={`markdown ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

interface MentionState {
  start: number;
  query: string;
  active: number;
}

/** Textarea with @mention autocomplete from workspace members. */
export const MentionTextarea = forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    onChange: (v: string) => void;
    members?: Member[];
    onSubmit?: () => void;
    label: string;
    placeholder?: string;
    rows?: number;
    disabled?: boolean;
    autoFocus?: boolean;
    className?: string;
    onCancel?: () => void;
  }
>(function MentionTextarea(
  { value, onChange, members = [], onSubmit, label, placeholder, rows = 4, disabled, autoFocus, className = "", onCancel },
  fwd,
) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(fwd, () => ref.current!);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  const [mention, setMention] = useState<MentionState | null>(null);
  const listId = useId();

  const matches = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return members.filter((m) => !q || m.handle.startsWith(q) || m.name.toLowerCase().includes(q)).slice(0, 6);
  }, [mention, members]);

  const detect = (el: HTMLTextAreaElement) => {
    const pos = el.selectionStart;
    if (pos !== el.selectionEnd) return setMention(null);
    const before = el.value.slice(0, pos);
    const m = /(^|[\s(])@([a-zA-Z0-9._-]{0,40})$/.exec(before);
    if (!m) return setMention(null);
    setMention((cur) => ({ start: pos - m[2]!.length - 1, query: m[2]!, active: cur && cur.query === m[2] ? cur.active : 0 }));
  };

  const insert = (m: Member) => {
    const el = ref.current;
    if (!el || !mention) return;
    const end = mention.start + 1 + mention.query.length;
    const next = `${value.slice(0, mention.start)}@${m.handle} ${value.slice(end)}`;
    onChange(next);
    setMention(null);
    const caret = mention.start + m.handle.length + 2;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const open = mention !== null && matches.length > 0;

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setMention((s) => (s ? { ...s, active: (s.active + d + matches.length) % matches.length } : s));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insert(matches[mention!.active] ?? matches[0]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmit?.();
      return;
    }
    if (e.key === "Escape" && onCancel) {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  return (
    <div className="mention-wrap">
      <textarea
        ref={ref}
        className={`textarea ${className}`}
        aria-label={label}
        placeholder={placeholder}
        rows={rows}
        value={value}
        disabled={disabled}
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${mention!.active}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          detect(e.target);
        }}
        onKeyDown={onKeyDown}
        onClick={(e) => detect(e.currentTarget)}
        onBlur={() => setTimeout(() => setMention(null), 150)}
      />
      {open && (
        <div id={listId} role="listbox" aria-label="Mention someone" className="mention-list">
          {matches.map((m, i) => (
            // biome-ignore lint/a11y/useFocusableInteractive: highlighted via aria-activedescendant from the textarea
            <div
              key={m.userId}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === mention!.active}
              className={`option${i === mention!.active ? " active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                insert(m);
              }}
            >
              <Avatar member={m} size={18} />
              <span className="option-label">{m.name}</span>
              <span className="option-hint">@{m.handle}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

/** Write/Preview tabs over a mention-aware textarea. */
export function MarkdownEditor({
  value,
  onChange,
  members,
  onSubmit,
  label,
  placeholder,
  rows = 6,
  autoFocus,
  onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  members?: Member[];
  onSubmit?: () => void;
  label: string;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  onCancel?: () => void;
}) {
  const [tab, setTab] = useState<"write" | "preview">("write");
  const id = useId();
  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next = tab === "write" ? "preview" : "write";
      setTab(next);
      document.getElementById(`${id}-${next}`)?.focus();
    }
  };
  return (
    <div className="md-editor">
      <div role="tablist" aria-label={`${label} mode`} className="md-tabs">
        {(["write", "preview"] as const).map((t) => (
          <button
            key={t}
            id={`${id}-${t}`}
            type="button"
            role="tab"
            aria-selected={tab === t}
            aria-controls={`${id}-panel`}
            tabIndex={tab === t ? 0 : -1}
            className={`md-tab${tab === t ? " active" : ""}`}
            onClick={() => setTab(t)}
            onKeyDown={onTabKey}
          >
            {t === "write" ? "Write" : "Preview"}
          </button>
        ))}
        <span className="md-hint">Markdown supported</span>
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`} className="md-panel">
        {tab === "write" ? (
          <MentionTextarea
            value={value}
            onChange={onChange}
            members={members}
            onSubmit={onSubmit}
            label={label}
            placeholder={placeholder}
            rows={rows}
            autoFocus={autoFocus}
            onCancel={onCancel}
          />
        ) : value.trim() ? (
          <Markdown source={value} className="md-preview" />
        ) : (
          <p className="muted md-preview">Nothing to preview.</p>
        )}
      </div>
    </div>
  );
}
