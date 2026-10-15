import type { Member, Priority, StateCategory, WorkflowState } from "@glasstrack/shared";
import { PRIORITY_LABELS } from "@glasstrack/shared";
import { hueOf, initials } from "../lib/format";

/** Status mark: ring for not started, half for started, filled with a tick for done, slash for canceled. */
export function StatusIcon({ state, size = 14 }: { state: Pick<WorkflowState, "category" | "color"> | undefined; size?: number }) {
  const color = state?.color ?? "var(--text-3)";
  const cat: StateCategory = state?.category ?? "unstarted";
  const r = 5.5;
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" className="status-icon">
      {cat === "backlog" && <circle cx="7" cy="7" r={r} fill="none" stroke={color} strokeWidth="1.6" strokeDasharray="2 1.6" />}
      {cat === "unstarted" && <circle cx="7" cy="7" r={r} fill="none" stroke={color} strokeWidth="1.6" />}
      {cat === "started" && (
        <>
          <circle cx="7" cy="7" r={r} fill="none" stroke={color} strokeWidth="1.6" />
          <path d={`M7 7 L7 ${7 - 3.5} A3.5 3.5 0 0 1 7 ${7 + 3.5} Z`} fill={color} />
        </>
      )}
      {cat === "completed" && (
        <>
          <circle cx="7" cy="7" r="6.2" fill={color} />
          <path
            d="M4.3 7.2 6.2 9 9.8 5.2"
            fill="none"
            stroke="var(--on-status)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
      {cat === "canceled" && (
        <>
          <circle cx="7" cy="7" r="6.2" fill={color} />
          <path d="M4.8 4.8 9.2 9.2M9.2 4.8 4.8 9.2" stroke="var(--on-status)" strokeWidth="1.5" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

/** Priority mark: three steps of a staircase for low..high, a filled square with "!" for urgent, a dash for none. */
export function PriorityIcon({ priority, size = 14 }: { priority: Priority; size?: number }) {
  const label = PRIORITY_LABELS[priority];
  if (priority === 0) {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" role="img" aria-label={label} className="prio-icon prio-0">
        <path d="M3 7h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="1.5 2" />
      </svg>
    );
  }
  if (priority === 1) {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" role="img" aria-label={label} className="prio-icon prio-1">
        <rect x="1.5" y="1.5" width="11" height="11" rx="3" fill="currentColor" />
        <path d="M7 4v3.6" stroke="var(--on-status)" strokeWidth="1.7" strokeLinecap="round" />
        <circle cx="7" cy="10" r="0.95" fill="var(--on-status)" />
      </svg>
    );
  }
  const filled = priority === 2 ? 3 : priority === 3 ? 2 : 1;
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" role="img" aria-label={label} className={`prio-icon prio-${priority}`}>
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={2 + i * 3.6}
          y={9 - i * 3}
          width="2.6"
          height={3 + i * 3}
          rx="0.8"
          fill="currentColor"
          opacity={i < filled ? 1 : 0.25}
        />
      ))}
    </svg>
  );
}

export function Avatar({
  member,
  size = 20,
  title,
}: {
  member: Pick<Member, "name" | "avatarUrl"> | null | undefined;
  size?: number;
  title?: string;
}) {
  if (!member) {
    return (
      <span
        className="avatar avatar-empty"
        style={{ width: size, height: size }}
        title={title ?? "Unassigned"}
        aria-label={title ?? "Unassigned"}
        role="img"
      >
        <svg viewBox="0 0 20 20" width={size} height={size} aria-hidden="true">
          <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2.5 2" />
        </svg>
      </span>
    );
  }
  const label = title ?? member.name;
  if (member.avatarUrl) {
    return (
      <img className="avatar" src={member.avatarUrl} alt={label} title={label} width={size} height={size} referrerPolicy="no-referrer" />
    );
  }
  const hue = hueOf(member.name);
  return (
    <span
      className="avatar"
      role="img"
      aria-label={label}
      title={label}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, size * 0.42),
        background: `hsl(${hue} 38% var(--avatar-l))`,
        color: "var(--avatar-fg)",
      }}
    >
      {initials(member.name)}
    </span>
  );
}

export function LabelDot({ color }: { color: string }) {
  return <span className="label-dot" style={{ background: color }} aria-hidden="true" />;
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** Up to `max` overlapping avatars, then "+N". Empty shows the unassigned ring. */
export function AvatarStack({
  ids,
  members,
  size = 18,
  max = 3,
}: {
  ids: string[];
  members: Map<string, Member> | Member[] | undefined;
  size?: number;
  max?: number;
}) {
  const find = (id: string) => (members instanceof Map ? members.get(id) : members?.find((m) => m.userId === id));
  if (ids.length === 0) return <Avatar member={null} size={size} />;
  const people = ids.map((id) => find(id) ?? { name: "Former member", avatarUrl: null });
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  const label = `Assigned to ${people.map((p) => p.name).join(", ")}`;
  return (
    <span className="avatar-stack" role="img" aria-label={label} title={label}>
      {shown.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: ids can repeat only for former members, order is stable
        <span key={`${ids[i]}-${i}`} className="avatar-stack-item" aria-hidden="true">
          <Avatar member={p} size={size} title="" />
        </span>
      ))}
      {extra > 0 && (
        <span className="avatar-more" aria-hidden="true" style={{ height: size, minWidth: size, fontSize: Math.max(9, size * 0.5) }}>
          +{extra}
        </span>
      )}
    </span>
  );
}
