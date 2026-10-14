export const paths = {
  home: (slug: string) => `/${slug}/my-issues`,
  inbox: (slug: string) => `/${slug}/inbox`,
  myIssues: (slug: string) => `/${slug}/my-issues`,
  teamIssues: (slug: string, key: string) => `/${slug}/team/${key}/issues`,
  teamBoard: (slug: string, key: string) => `/${slug}/team/${key}/board`,
  teamBacklog: (slug: string, key: string) => `/${slug}/team/${key}/backlog`,
  teamCycles: (slug: string, key: string) => `/${slug}/team/${key}/cycles`,
  view: (slug: string, id: string) => `/${slug}/view/${id}`,
  issue: (slug: string, identifier: string) => `/${slug}/issue/${identifier}`,
  settings: (slug: string, tab?: string) => (tab && tab !== "general" ? `/${slug}/settings/${tab}` : `/${slug}/settings`),
  finances: () => "/finances",
  admin: () => "/admin",
};

const LAST_WS = "glasstrack-last-ws";
export function rememberWorkspace(slug: string) {
  try {
    localStorage.setItem(LAST_WS, slug);
  } catch {
    // storage blocked
  }
}
export function lastWorkspace(): string | null {
  try {
    return localStorage.getItem(LAST_WS);
  } catch {
    return null;
  }
}
