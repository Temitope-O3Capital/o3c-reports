import type { ReactNode } from "react";

export function EmptyState({ icon, title, description, action }: {
  icon?: ReactNode; title: string; description?: string; action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action && <button className="btn" onClick={action.onClick} style={{ marginTop: 12 }}>{action.label}</button>}
    </div>
  );
}
