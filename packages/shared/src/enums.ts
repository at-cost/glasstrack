export const ROLES = ["admin", "member", "guest"] as const;
export type Role = (typeof ROLES)[number];

export const STATE_CATEGORIES = ["backlog", "unstarted", "started", "completed", "canceled"] as const;
export type StateCategory = (typeof STATE_CATEGORIES)[number];

export const DEFAULT_STATES: { name: string; category: StateCategory; color: string }[] = [
  { name: "Backlog", category: "backlog", color: "#8a8f98" },
  { name: "Todo", category: "unstarted", color: "#b4b9c2" },
  { name: "In Progress", category: "started", color: "#e0a526" },
  { name: "In Review", category: "started", color: "#3fa36b" },
  { name: "Done", category: "completed", color: "#4a7bd0" },
  { name: "Cancelled", category: "canceled", color: "#a05252" },
];

/** 0 = none, 1 = urgent, 2 = high, 3 = medium, 4 = low */
export const PRIORITIES = [0, 1, 2, 3, 4] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<Priority, string> = {
  0: "No priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

export const RELATION_TYPES = ["blocks", "related", "duplicate"] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export const DIGEST_FREQUENCIES = ["off", "hourly", "daily"] as const;
export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number];

export const NOTIFICATION_KINDS = ["assigned", "mentioned", "commented", "status_changed"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
