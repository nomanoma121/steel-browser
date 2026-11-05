import type { SessionDetails } from "./api";

export type SessionGroups = {
  active: SessionDetails[];
  ended: SessionDetails[];
};

export function isActive(session: SessionDetails): boolean {
  return session.status === "live" || session.status === "idle";
}

function newestFirst(a: SessionDetails, b: SessionDetails): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

export function groupSessions(
  sessions: SessionDetails[],
  selectedId: string | null,
  endedLimit = 10,
): SessionGroups {
  const sorted = [...sessions].sort(newestFirst);
  const ended = sorted.filter((session) => !isActive(session));
  return {
    active: sorted.filter(isActive),
    ended: ended.filter((session, index) => index < endedLimit || session.id === selectedId),
  };
}

export function pickSession(
  sessions: SessionDetails[],
  selectedId: string | null,
): SessionDetails | null {
  const selected = selectedId ? sessions.find((session) => session.id === selectedId) : undefined;
  if (selected) return selected;
  const active = sessions.filter(isActive).sort(newestFirst);
  return active.find((session) => session.status === "live") ?? active[0] ?? null;
}
