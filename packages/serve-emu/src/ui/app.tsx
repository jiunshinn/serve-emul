import { useCallback, useEffect, useRef, useState } from "react";
import { StatusBar } from "./components/status-bar";
import { AppManagementPanel } from "./components/app-management-panel";
import { AccessibilityPanel, type AccessibilityNode } from "./components/accessibility-panel";
import { DevicePanel, OrientationPanel } from "./components/device-panel";
import { DeviceStream } from "./components/device-stream";
import { ControlBar, type HardwareKey } from "./components/control-bar";
import { LogcatPanel } from "./components/logcat-panel";
import { LocationPanel } from "./components/location-panel";
import { SessionPanel } from "./components/session-panel";
import { useStream } from "./lib/use-stream";

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { state, send } = useStream(canvasRef);
  const [accessibilityEnabled, setAccessibilityEnabled] = useState(false);
  const [accessibilityNodes, setAccessibilityNodes] = useState<AccessibilityNode[]>([]);
  const [highlightedAccessibilityId, setHighlightedAccessibilityId] = useState<string | null>(null);
  const [devicesOpen, setDevicesOpen] = useState(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target !== document.body) return;
      if (e.key === "Escape") {
        send({ type: "back" });
        return;
      }
      if (e.key === "Enter") {
        send({ type: "key", keycode: 66 });
        return;
      }
      if (e.key.length === 1) {
        send({ type: "text", text: e.key });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [send]);

  const onPress = useCallback(
    (key: HardwareKey) => send({ type: key }),
    [send],
  );

  return (
    <>
      <StatusBar status={state.status} deviceSize={state.deviceSize} fps={state.fps} />
      <main className={devicesOpen ? "app-layout devices-open" : "app-layout devices-collapsed"}>
        <aside className="device-sidebar" aria-label="Devices sidebar">
          <div className="device-sidebar-header">
            <button
              type="button"
              className="sidebar-toggle"
              onClick={() => setDevicesOpen((open) => !open)}
              aria-label={devicesOpen ? "Collapse devices sidebar" : "Expand devices sidebar"}
              title={devicesOpen ? "Collapse devices" : "Expand devices"}
            >
              <SidebarIcon collapsed={!devicesOpen} />
            </button>
            {devicesOpen ? <span>Devices</span> : null}
          </div>
          {devicesOpen ? <DevicePanel /> : null}
        </aside>
        <div className="device">
          <DeviceStream
            canvasRef={canvasRef}
            send={send}
            accessibilityEnabled={accessibilityEnabled}
            accessibilityNodes={accessibilityNodes}
            highlightedAccessibilityId={highlightedAccessibilityId}
            deviceSize={state.deviceSize}
          />
        </div>
        <aside className="side-panel">
          <OrientationPanel />
          <AccessibilityPanel
            enabled={accessibilityEnabled}
            nodes={accessibilityNodes}
            highlightedId={highlightedAccessibilityId}
            onEnabledChange={setAccessibilityEnabled}
            onNodesChange={setAccessibilityNodes}
            onHighlight={setHighlightedAccessibilityId}
          />
          <LocationPanel />
          <AppManagementPanel />
          <LogcatPanel />
          <SessionPanel />
        </aside>
      </main>
      <ControlBar onPress={onPress} />
    </>
  );
}

function SidebarIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={collapsed ? "sidebar-icon collapsed" : "sidebar-icon"}
      viewBox="0 0 20 20"
      fill="none"
    >
      <rect x="3" y="3" width="14" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 3.75V16.25" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M12.5 7.5L10 10L12.5 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
