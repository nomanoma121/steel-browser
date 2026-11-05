import { useCallback, useEffect } from "react";
import { Notice } from "./components/notice";
import { Rail, type ApiStatus } from "./components/rail";
import { SessionConsole } from "./components/session-console";
import { SessionList } from "./components/session-list";
import { Stage } from "./components/stage";
import { TopBar } from "./components/top-bar";
import { useSelectedSessionId, useSessions, useShortcutKeys, useStoredToggle } from "./hooks";
import { pickSession } from "./sessions";

export function App() {
  const { sessions, error, reload } = useSessions();
  const [selectedId, select] = useSelectedSessionId();
  const [railOpen, toggleRail] = useStoredToggle("steel-browser:rail", true);
  const [consoleOpen, toggleConsole] = useStoredToggle("steel-browser:console", true);
  const [devtoolsOpen, toggleDevtools] = useStoredToggle("steel-browser:devtools", false);
  useShortcutKeys();

  const session = sessions && pickSession(sessions, selectedId);
  const sessionId = session?.id ?? null;

  useEffect(() => {
    if (sessions && sessionId !== selectedId) select(sessionId);
  }, [sessions, sessionId, selectedId, select]);

  const showSession = useCallback(
    async (id: string | null) => {
      await reload().catch(() => undefined);
      select(id);
    },
    [reload, select],
  );

  const status: ApiStatus = error
    ? sessions
      ? "reconnecting"
      : "offline"
    : sessions === undefined
    ? "connecting"
    : "online";

  return (
    <div className="shell" data-rail={railOpen ? "open" : "closed"}>
      {railOpen && (
        <Rail status={status} onCollapse={toggleRail}>
          {sessions && <SessionList sessions={sessions} selectedId={sessionId} onSelect={select} />}
        </Rail>
      )}
      <div className="body">
        <main className="panel">
          <TopBar
            session={session}
            sessions={sessions}
            railOpen={railOpen}
            onToggleRail={toggleRail}
            consoleOpen={consoleOpen}
            onToggleConsole={toggleConsole}
            devtoolsOpen={devtoolsOpen}
            onToggleDevtools={toggleDevtools}
            onSelect={select}
            onStarted={(id) => void showSession(id)}
            onReleased={() => void showSession(null)}
          />
          {session ? (
            <div key={session.id} className="workspace">
              <SessionConsole session={session} hidden={!consoleOpen} />
              <Stage session={session} devtoolsOpen={devtoolsOpen} />
            </div>
          ) : error ? (
            <Notice title="Can't reach the Steel API">
              Make sure the API is running. This page reconnects on its own.
            </Notice>
          ) : session === null ? (
            <Notice title="No session">
              Start one with the Start session button or <code>POST /v1/sessions</code>.
            </Notice>
          ) : (
            <Notice title="Connecting" busy />
          )}
        </main>
      </div>
    </div>
  );
}
