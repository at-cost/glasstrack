import { Check } from "lucide-react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fuzzyFilter } from "../lib/fuzzy";

export interface Option {
  id: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  keywords?: string;
  group?: string;
}

/**
 * Text input with a listbox (combobox pattern). Arrow keys move, Enter picks,
 * Escape closes. In multi mode Enter toggles and the list stays open.
 */
export function OptionList({
  options,
  selected = [],
  multi = false,
  onPick,
  onClose,
  placeholder = "Search",
  label,
  filter = true,
  query: controlledQuery,
  onQueryChange,
  emptyText = "No matches",
  autoFocus = true,
}: {
  options: Option[];
  selected?: string[];
  multi?: boolean;
  onPick: (id: string) => void;
  onClose?: () => void;
  placeholder?: string;
  label: string;
  filter?: boolean;
  query?: string;
  onQueryChange?: (q: string) => void;
  emptyText?: string;
  autoFocus?: boolean;
}) {
  const [innerQuery, setInnerQuery] = useState("");
  const query = controlledQuery ?? innerQuery;
  const setQuery = (q: string) => {
    setActive(0);
    if (onQueryChange) onQueryChange(q);
    else setInnerQuery(q);
  };
  const shown = useMemo(
    () => (filter ? fuzzyFilter(options, query, (o) => `${o.label} ${o.keywords ?? ""} ${o.hint ?? ""}`) : options),
    [options, query, filter],
  );
  const [rawActive, setActive] = useState(0);
  // Results can shrink (async search), so keep the highlight in range.
  const active = Math.max(0, Math.min(rawActive, shown.length - 1));
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (o: Option | undefined) => {
    if (!o) return;
    onPick(o.id);
    if (!multi) onClose?.();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Home" && e.ctrlKey) {
      setActive(0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(shown[active]);
    } else if (e.key === "Escape") {
      if (onClose) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    } else if (e.key === "Tab" && onClose && !e.shiftKey && multi) {
      onClose();
    }
  };

  let lastGroup: string | undefined;
  return (
    <div className="optionlist">
      <input
        ref={inputRef}
        className="optionlist-input"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={label}
        aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        autoComplete="off"
        spellCheck={false}
      />
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={label}
        aria-multiselectable={multi || undefined}
        className="optionlist-list"
      >
        {shown.length === 0 && <div className="optionlist-empty">{emptyText}</div>}
        {shown.map((o, i) => {
          const isSel = selected.includes(o.id);
          const header = o.group && o.group !== lastGroup ? o.group : null;
          lastGroup = o.group;
          return (
            <div key={`${o.group ?? ""}${o.id}`} role="presentation">
              {header && (
                <div className="optionlist-group" aria-hidden="true">
                  {header}
                </div>
              )}
              {/* biome-ignore lint/a11y: options are driven from the combobox input via aria-activedescendant, so they are not focusable themselves */}
              <div
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={multi ? isSel : i === active}
                aria-checked={multi ? isSel : undefined}
                className={`option${i === active ? " active" : ""}${isSel ? " selected" : ""}`}
                onMouseMove={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(o)}
              >
                {multi && (
                  <span className={`checkbox${isSel ? " on" : ""}`} aria-hidden="true">
                    {isSel && <Check size={11} strokeWidth={3} />}
                  </span>
                )}
                {o.icon && <span className="option-icon">{o.icon}</span>}
                <span className="option-label">{o.label}</span>
                {o.hint && <span className="option-hint">{o.hint}</span>}
                {!multi && isSel && <Check size={14} className="option-check" aria-hidden="true" />}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A floating panel anchored to an element, rendered in a portal so overflow never clips it. */
export function Popover({
  anchor,
  onClose,
  children,
  width = 260,
  label,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = Math.min(width, vw - 16);
      const left = Math.max(8, Math.min(r.left, vw - w - 8));
      const below = vh - r.bottom - 8;
      const above = r.top - 8;
      if (below >= 240 || below >= above) setPos({ top: r.bottom + 4, left, maxHeight: Math.max(160, below - 4) });
      else setPos({ top: Math.max(8, r.top - Math.min(360, above) - 4), left, maxHeight: Math.min(360, above) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, width]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    const el = ref.current;
    el?.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      el?.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div
      ref={ref}
      className="popover"
      role="dialog"
      aria-label={label}
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width: Math.min(width, window.innerWidth - 16),
        maxHeight: pos?.maxHeight,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/** A button that opens an OptionList in a popover. */
export function PickerButton({
  label,
  children,
  options,
  selected,
  multi,
  onPick,
  disabled,
  className = "prop-btn",
  placeholder,
  testId,
  footer,
}: {
  label: string;
  children: ReactNode;
  options: Option[];
  selected: string[];
  multi?: boolean;
  onPick: (id: string) => void;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  testId?: string;
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={className}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        data-testid={testId}
        onClick={() => setOpen((o) => !o)}
      >
        {children}
      </button>
      {open && (
        <Popover anchor={btn.current} onClose={close} label={label}>
          <OptionList
            label={label}
            options={options}
            selected={selected}
            multi={multi}
            onPick={onPick}
            onClose={close}
            placeholder={placeholder ?? `${label}...`}
          />
          {footer}
        </Popover>
      )}
    </>
  );
}
