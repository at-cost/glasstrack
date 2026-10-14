import type { ReactNode } from "react";

export function Card({
  title,
  children,
  danger,
  actions,
  id,
}: {
  title: string;
  children: ReactNode;
  danger?: boolean;
  actions?: ReactNode;
  id?: string;
}) {
  return (
    <div className={`card-box${danger ? " danger" : ""}`} id={id}>
      {actions ? (
        <div className="card-head">
          <h2 className="card-title">{title}</h2>
          <div className="card-actions">{actions}</div>
        </div>
      ) : (
        <h2 className="card-title">{title}</h2>
      )}
      {children}
    </div>
  );
}
