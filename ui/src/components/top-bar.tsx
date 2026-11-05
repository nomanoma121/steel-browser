import type { SessionDetails } from "../api";
import { CopyButton } from "./copy-button";
import { ChevronRightIcon, ConsoleIcon, DevToolsIcon, RailIcon } from "./icons";
import { NewSessionButton } from "./new-session";
import { ReleaseButton } from "./release-button";
import { SessionSwitcher } from "./session-list";

export function TopBar({
  session,
  sessions,
  railOpen,
  onToggleRail,
  consoleOpen,
  onToggleConsole,
  devtoolsOpen,
  onToggleDevtools,
  onSelect,
  onStarted,
  onReleased,
}: {
  session: SessionDetails | null | undefined;
  sessions: SessionDetails[] | undefined;
  railOpen: boolean;
  onToggleRail: () => void;
  consoleOpen: boolean;
  onToggleConsole: () => void;
  devtoolsOpen: boolean;
  onToggleDevtools: () => void;
  onSelect: (id: string) => void;
  onStarted: (id: string) => void;
  onReleased: () => void;
}) {
  const consoleLabel = consoleOpen ? "Hide logs" : "Show logs";
  const devtoolsLabel = devtoolsOpen ? "Hide DevTools" : "Show DevTools";

  return (
    <header className="top-bar">
      {!railOpen && (
        <button
          type="button"
          className="bar-button rail-toggle"
          aria-label="Expand sidebar"
          aria-expanded={false}
          title="Expand sidebar"
          onClick={onToggleRail}
        >
          <RailIcon />
        </button>
      )}
      {session && (
        <button
          type="button"
          className="bar-button"
          aria-label={consoleLabel}
          aria-pressed={consoleOpen}
          title={consoleLabel}
          onClick={onToggleConsole}
        >
          <ConsoleIcon />
        </button>
      )}
      {session?.status === "live" && session.debugUrl && (
        <button
          type="button"
          className="bar-button devtools-toggle"
          aria-label={devtoolsLabel}
          aria-pressed={devtoolsOpen}
          title={devtoolsLabel}
          onClick={onToggleDevtools}
        >
          <DevToolsIcon />
        </button>
      )}
      <nav className="crumbs" aria-label="Breadcrumb">
        <span className="crumb-parent">Sessions</span>
        {session && (
          <>
            <ChevronRightIcon className="crumb-sep" />
            <span className="crumb-current" aria-current="page" title={session.id}>
              {session.id}
            </span>
            <CopyButton className="crumb-copy" value={session.id} label="Copy session ID" />
          </>
        )}
      </nav>
      {sessions && (
        <div className="top-bar-actions">
          <SessionSwitcher
            sessions={sessions}
            selectedId={session?.id ?? null}
            onSelect={onSelect}
          />
          {session?.status === "live" && (
            <ReleaseButton sessionId={session.id} onReleased={onReleased} />
          )}
          <NewSessionButton onStarted={onStarted} />
        </div>
      )}
    </header>
  );
}
