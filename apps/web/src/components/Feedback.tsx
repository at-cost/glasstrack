import { X } from "lucide-react";
import { dismissToast, useToasts } from "../lib/toast";

export function Toaster() {
  const toasts = useToasts();
  return (
    <div className="toast-region" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
          <span>{t.message}</span>
          <button type="button" className="icon-btn small" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Skeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="skeleton-list" role="status" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
        <div key={i} className="skeleton-row">
          <span className="skeleton" style={{ width: 14 }} />
          <span className="skeleton" style={{ width: 54 }} />
          <span className="skeleton" style={{ width: `${40 + ((i * 37) % 40)}%` }} />
        </div>
      ))}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function FullPageLoading() {
  return (
    <div className="center-page">
      <Spinner />
    </div>
  );
}
