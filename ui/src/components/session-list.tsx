import type { SessionDetails } from "../api";
import { formatTime } from "../format";
import { groupSessions } from "../sessions";

const statusLabels: Record<SessionDetails["status"], string> = {
  idle: "Starting",
  live: "Live",
  released: "Released",
  failed: "Failed",
};

function shortId(id: string): string {
  return id.slice(0, 8);
}

function SessionItem({
  session,
  selected,
  onSelect,
}: {
  session: SessionDetails;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className="rail-item session-item"
      aria-current={selected ? "true" : undefined}
      title={`${session.id} (${statusLabels[session.status]})`}
      onClick={() => onSelect(session.id)}
    >
      <span className="session-dot" data-status={session.status} aria-hidden="true" />
      <span className="rail-item-label session-item-id">{shortId(session.id)}</span>
      <span className="session-item-time">{formatTime(session.createdAt)}</span>
    </button>
  );
}

export function SessionList({
  sessions,
  selectedId,
  onSelect,
}: {
  sessions: SessionDetails[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { active, ended } = groupSessions(sessions, selectedId);
  const groups = [
    { title: "Live sessions", items: active, empty: "No live sessions" },
    { title: "Ended", items: ended, empty: null },
  ];

  return groups.map(({ title, items, empty }) =>
    items.length > 0 || empty ? (
      <div key={title} className="rail-group">
        <p className="rail-group-title">{title}</p>
        <div className="rail-items">
          {items.length > 0 ? (
            items.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                selected={session.id === selectedId}
                onSelect={onSelect}
              />
            ))
          ) : (
            <p className="rail-empty">{empty}</p>
          )}
        </div>
      </div>
    ) : null,
  );
}

export function SessionSwitcher({
  sessions,
  selectedId,
  onSelect,
}: {
  sessions: SessionDetails[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { active, ended } = groupSessions(sessions, selectedId);
  if (active.length + ended.length < 2) return null;

  const option = (session: SessionDetails) => (
    <option key={session.id} value={session.id}>
      {shortId(session.id)} · {statusLabels[session.status]} · {formatTime(session.createdAt)}
    </option>
  );

  return (
    <select
      className="session-switcher"
      aria-label="Switch session"
      value={selectedId ?? ""}
      onChange={(event) => onSelect(event.target.value)}
    >
      {active.length > 0 && <optgroup label="Live sessions">{active.map(option)}</optgroup>}
      {ended.length > 0 && <optgroup label="Ended">{ended.map(option)}</optgroup>}
    </select>
  );
}
