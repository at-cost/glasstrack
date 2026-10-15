import {
  type Announcements,
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useNavigate } from "@tanstack/react-router";
import { type Issue, keyBetween, type Label, type Member, type WorkflowState } from "@glasstrack/shared";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AvatarStack, LabelDot, PriorityIcon, StatusIcon } from "../../components/icons";
import { dueState, formatDueDate } from "../../lib/format";
import { useMoveIssue } from "../../lib/mutations";
import { paths } from "../../lib/paths";
import { useLabels, useMembers, useStates } from "../../lib/queries";
import { currentIssueStore, ui } from "../../lib/store";
import { teamStates } from "../issue/options";
import { useWs } from "../shell/context";

type Columns = Record<string, string[]>;
const COL = "col:";

function buildColumns(issues: Issue[], states: WorkflowState[]): Columns {
  const cols: Columns = {};
  for (const s of states) cols[s.id] = [];
  const sorted = [...issues].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  for (const i of sorted) cols[i.statusId]?.push(i.id);
  return cols;
}

function containerOf(cols: Columns, id: string): string | undefined {
  if (id.startsWith(COL)) return id.slice(COL.length);
  return Object.keys(cols).find((k) => cols[k]!.includes(id));
}

export function Board({ issues, teamId, statusIds }: { issues: Issue[]; teamId: string; statusIds?: string[] }) {
  const { slug, canEdit } = useWs();
  const states = useStates(slug);
  const labels = useLabels(slug);
  const members = useMembers(slug);
  const move = useMoveIssue(slug);
  const columnsStates = useMemo(
    () => teamStates(states.data, teamId).filter((s) => !statusIds?.length || statusIds.includes(s.id)),
    [states.data, teamId, statusIds],
  );
  const byId = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues]);
  const derived = useMemo(() => buildColumns(issues, columnsStates), [issues, columnsStates]);
  const [cols, setCols] = useState<Columns>(derived);
  const [activeId, setActiveId] = useState<string | null>(null);
  const startCol = useRef<string | null>(null);
  const justDragged = useRef(false);

  useEffect(() => {
    if (!activeId) setCols(derived);
  }, [derived, activeId]);

  const colsRef = useRef(cols);
  colsRef.current = cols;
  const orderRef = useRef<string[]>([]);
  orderRef.current = columnsStates.map((s) => s.id);
  // Left/Right jump to the neighbouring column; Up/Down move within it.
  const coordinateGetter: KeyboardCoordinateGetter = useCallback((event, args) => {
    if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
      event.preventDefault();
      const active = args.context.active;
      if (!active) return undefined;
      const cur = containerOf(colsRef.current, String(active.id));
      const order = orderRef.current;
      const target = order[order.indexOf(cur ?? "") + (event.code === "ArrowRight" ? 1 : -1)];
      if (!target) return undefined;
      const rect = args.context.droppableRects.get(`${COL}${target}`);
      if (!rect) return undefined;
      return { x: rect.left + 4, y: rect.top + 4 };
    }
    return sortableKeyboardCoordinates(event, args);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );

  const stateName = (id: string | undefined) => columnsStates.find((s) => s.id === id)?.name ?? "column";
  const ident = (id: string | number) => byId.get(String(id))?.identifier ?? "issue";
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${ident(active.id)}. Use arrow keys to move, Space to drop, Escape to cancel.`,
    onDragOver: ({ active, over }) =>
      over ? `${ident(active.id)} is over ${stateName(containerOf(cols, String(over.id)))}.` : `${ident(active.id)} is not over a column.`,
    onDragEnd: ({ active, over }) =>
      over ? `Dropped ${ident(active.id)} in ${stateName(containerOf(cols, String(over.id)))}.` : `Dropped ${ident(active.id)}.`,
    onDragCancel: ({ active }) => `Moving ${ident(active.id)} was cancelled.`,
  };

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    setActiveId(id);
    startCol.current = containerOf(cols, id) ?? null;
  };

  const onDragOver = (e: DragOverEvent) => {
    const { active, over } = e;
    if (!over) return;
    const a = String(active.id);
    const o = String(over.id);
    const from = containerOf(cols, a);
    const to = containerOf(cols, o);
    if (!from || !to || from === to) return;
    setCols((prev) => {
      const fromList = prev[from]!.filter((x) => x !== a);
      const toList = [...prev[to]!];
      const overIndex = o.startsWith(COL) ? toList.length : toList.indexOf(o);
      const below =
        over.rect && active.rect.current.translated ? active.rect.current.translated.top > over.rect.top + over.rect.height / 2 : false;
      const index = overIndex < 0 ? toList.length : overIndex + (below && !o.startsWith(COL) ? 1 : 0);
      toList.splice(index, 0, a);
      return { ...prev, [from]: fromList, [to]: toList };
    });
  };

  const finish = (e: DragEndEvent) => {
    const a = String(e.active.id);
    const over = e.over ? String(e.over.id) : null;
    setActiveId(null);
    justDragged.current = true;
    setTimeout(() => {
      justDragged.current = false;
    }, 0);
    const issue = byId.get(a);
    if (!over || !issue) {
      setCols(derived);
      return;
    }
    const col = containerOf(cols, a);
    if (!col) return setCols(derived);
    let list = cols[col]!;
    if (!over.startsWith(COL) && containerOf(cols, over) === col) {
      const oldIndex = list.indexOf(a);
      const newIndex = list.indexOf(over);
      if (oldIndex !== newIndex) list = arrayMove(list, oldIndex, newIndex);
    }
    setCols((prev) => ({ ...prev, [col]: list }));
    const idx = list.indexOf(a);
    const afterId = idx > 0 ? list[idx - 1]! : null;
    const beforeId = idx < list.length - 1 ? list[idx + 1]! : null;
    const orig = derived[issue.statusId] ?? [];
    const origIdx = orig.indexOf(a);
    const unchanged =
      col === issue.statusId && orig[origIdx - 1] === (afterId ?? undefined) && orig[origIdx + 1] === (beforeId ?? undefined);
    if (unchanged) return;
    let sortKey = issue.sortKey;
    try {
      sortKey = keyBetween(afterId ? (byId.get(afterId)?.sortKey ?? null) : null, beforeId ? (byId.get(beforeId)?.sortKey ?? null) : null);
    } catch {
      // the server will compute the real key
    }
    move.mutate({ issue, statusId: col, afterId, beforeId, sortKey });
  };

  const labelById = useMemo(() => new Map((labels.data ?? []).map((l) => [l.id, l])), [labels.data]);
  const memberById = useMemo(() => new Map((members.data ?? []).map((m) => [m.userId, m])), [members.data]);
  const active = activeId ? byId.get(activeId) : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={finish}
      onDragCancel={() => {
        setActiveId(null);
        setCols(derived);
      }}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable: "To move a card, press Space. Use arrow keys to move it, Space to drop, Escape to cancel. Press Enter to open it.",
        },
      }}
    >
      <div className="board">
        {columnsStates.map((s) => (
          <Column key={s.id} state={s} ids={cols[s.id] ?? []} teamId={teamId} canEdit={canEdit}>
            {(cols[s.id] ?? []).map((id) => {
              const i = byId.get(id);
              if (!i) return null;
              return (
                <SortableCard
                  key={id}
                  issue={i}
                  disabled={!canEdit || id.startsWith("temp-")}
                  labels={i.labelIds.map((l) => labelById.get(l)).filter((l): l is Label => Boolean(l))}
                  members={memberById}
                  justDragged={justDragged}
                  slug={slug}
                />
              );
            })}
          </Column>
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {active ? (
          <CardBody
            issue={active}
            labels={active.labelIds.map((l) => labelById.get(l)).filter((l): l is Label => Boolean(l))}
            members={memberById}
            overlay
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function Column({
  state,
  ids,
  teamId,
  canEdit,
  children,
}: {
  state: WorkflowState;
  ids: string[];
  teamId: string;
  canEdit: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${COL}${state.id}` });
  return (
    <section
      className={`board-col${isOver ? " over" : ""}`}
      data-testid={`board-column-${state.name}`}
      aria-label={`${state.name}, ${ids.length} issues`}
    >
      <header className="board-col-head">
        <StatusIcon state={state} />
        <span className="board-col-name">{state.name}</span>
        <span className="group-count">{ids.length}</span>
        {canEdit && (
          <button
            type="button"
            className="icon-btn small"
            aria-label={`New issue in ${state.name}`}
            onClick={() => ui.openCreate({ teamId, statusId: state.id })}
          >
            <Plus size={14} />
          </button>
        )}
      </header>
      <SortableContext id={state.id} items={ids} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className="board-col-body">
          {children}
          {ids.length === 0 && <div className="board-empty">Drop issues here</div>}
        </div>
      </SortableContext>
    </section>
  );
}

function CardBody({ issue, labels, members, overlay }: { issue: Issue; labels: Label[]; members: Map<string, Member>; overlay?: boolean }) {
  const due = dueState(issue.dueDate);
  return (
    <div className={`card-inner${overlay ? " overlay" : ""}`}>
      <div className="card-top">
        <span className="issue-id">{issue.id.startsWith("temp-") ? "New" : issue.identifier}</span>
        <AvatarStack ids={issue.assigneeIds} members={members} size={18} />
      </div>
      <div className="card-title">{issue.title}</div>
      {(issue.priority > 0 || issue.dueDate || labels.length > 0) && (
        <div className="card-meta">
          {issue.priority > 0 && <PriorityIcon priority={issue.priority} />}
          {issue.dueDate && <span className={`due due-${due}`}>{formatDueDate(issue.dueDate)}</span>}
          {labels.map((l) => (
            <span key={l.id} className="label-chip">
              <LabelDot color={l.color} />
              {l.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function SortableCard({
  issue,
  labels,
  members,
  disabled,
  justDragged,
  slug,
}: {
  issue: Issue;
  labels: Label[];
  members: Map<string, Member>;
  disabled: boolean;
  justDragged: React.RefObject<boolean>;
  slug: string;
}) {
  const navigate = useNavigate();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: issue.id, disabled });
  const open = () => {
    if (issue.id.startsWith("temp-")) return;
    navigate({ to: paths.issue(slug, issue.identifier) });
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: the card holds block content and is also the dnd-kit drag handle
    <div
      ref={setNodeRef}
      className={`card${isDragging ? " dragging" : ""}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-testid={`issue-card-${issue.identifier}`}
      data-issue-row
      {...attributes}
      {...listeners}
      role="button"
      aria-roledescription="draggable card"
      aria-label={`${issue.identifier} ${issue.title}`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !isDragging) {
          e.preventDefault();
          open();
          return;
        }
        listeners?.onKeyDown?.(e);
      }}
      onClick={() => {
        if (justDragged.current) return;
        open();
      }}
      onFocus={() => currentIssueStore.set(issue.id)}
      onBlur={() => {
        if (currentIssueStore.get() === issue.id) currentIssueStore.set(null);
      }}
    >
      <CardBody issue={issue} labels={labels} members={members} />
    </div>
  );
}
