export interface JobPayloads {
  "export.workspace": { exportId: string; workspaceId: string };
  "workspace.delete": { workspaceId: string };
  "notifications.digest": Record<string, never>;
  "maintenance.cleanup": Record<string, never>;
  "backup.run": Record<string, never>;
  "billing.daily": Record<string, never>;
  "billing.autotopup": { workspaceId: string };
  "billing.fees": Record<string, never>;
}
export type JobName = keyof JobPayloads;

export interface Jobs {
  send<N extends JobName>(name: N, data: JobPayloads[N]): Promise<void>;
}
