/** Matches @handles in markdown, ignoring email addresses and code spans. */
export function extractMentions(md: string): string[] {
  const withoutCode = md.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  const out = new Set<string>();
  for (const m of withoutCode.matchAll(/(^|[^\w@.])@([a-zA-Z0-9][a-zA-Z0-9._-]{0,39})/g)) {
    out.add(m[2]!.replace(/[._-]+$/, "").toLowerCase());
  }
  return [...out];
}

/** "ENG-123" -> { key: "ENG", number: 123 } */
export function parseIssueKey(s: string): { key: string; number: number } | null {
  const m = /^([A-Za-z][A-Za-z0-9]{1,4})-(\d{1,9})$/.exec(s.trim());
  if (!m) return null;
  return { key: m[1]!.toUpperCase(), number: Number(m[2]) };
}

/** A user's mention handle: the local part of their email, lowercased. */
export function mentionHandle(email: string): string {
  return email.split("@")[0]!.toLowerCase();
}
