import type { Me, Workspace } from "@glasstrack/shared";
import { createContext, useContext } from "react";

export interface WsContext {
  slug: string;
  workspace: Workspace;
  me: Me;
  isAdmin: boolean;
  /** Read-only, free role: sees what members see, changes nothing. */
  isViewer: boolean;
  /** False for viewers and while the workspace is read-only. */
  canEdit: boolean;
}

export const WorkspaceCtx = createContext<WsContext | null>(null);

export function useWs(): WsContext {
  const v = useContext(WorkspaceCtx);
  if (!v) throw new Error("useWs outside workspace");
  return v;
}

export function useOptionalWs(): WsContext | null {
  return useContext(WorkspaceCtx);
}
