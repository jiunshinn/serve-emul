import { useCallback, useEffect, useState } from "react";

type Device = {
  serial: string;
  state: string;
  current: boolean;
};

type Orientation = "auto" | "portrait" | "landscape";
type OrientationResponse = {
  ok?: boolean;
  orientation?: { orientation?: Orientation | "unknown"; raw?: string };
  error?: string;
};

export function DevicePanel() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [status, setStatus] = useState("Loading...");
  const [orientation, setOrientation] = useState<Orientation | "unknown">("unknown");
  const [orientationStatus, setOrientationStatus] = useState("Loading...");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/devices", { cache: "no-store" });
      const json = await res.json() as { ok?: boolean; devices?: Device[]; error?: string };
      if (!json.ok || !json.devices) {
        setDevices([]);
        setStatus(json.error || "Unavailable");
        return;
      }
      setDevices(json.devices);
      setStatus(`${json.devices.length} device${json.devices.length === 1 ? "" : "s"}`);
    } catch (err) {
      setDevices([]);
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const refreshOrientation = useCallback(async () => {
    try {
      const res = await fetch("/api/orientation", { cache: "no-store" });
      const json = await res.json() as OrientationResponse;
      if (!json.ok || !json.orientation) {
        setOrientation("unknown");
        setOrientationStatus(json.error || "Unavailable");
        return;
      }
      const next = json.orientation.orientation ?? "unknown";
      setOrientation(next);
      setOrientationStatus(next === "unknown" ? json.orientation.raw || "Unknown" : next);
    } catch (err) {
      setOrientation("unknown");
      setOrientationStatus(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const setDeviceOrientation = useCallback(async (next: Orientation) => {
    setOrientationStatus("Applying...");
    try {
      const res = await fetch("/api/orientation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orientation: next }),
      });
      const json = await res.json() as OrientationResponse;
      if (!json.ok || !json.orientation) {
        setOrientationStatus(json.error || "Failed");
        return;
      }
      const applied = json.orientation.orientation ?? "unknown";
      setOrientation(applied);
      setOrientationStatus(applied === "unknown" ? json.orientation.raw || "Unknown" : applied);
    } catch (err) {
      setOrientationStatus(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshOrientation();
    const timer = setInterval(() => {
      void refresh();
      void refreshOrientation();
    }, 3000);
    return () => clearInterval(timer);
  }, [refresh, refreshOrientation]);

  return (
    <section className="tool-panel device-panel">
      <div className="panel-heading">
        <h2>Devices</h2>
        <div className="location-status">{status}</div>
      </div>
      <div className="device-list">
        {devices.length === 0 ? (
          <div className="device-empty">No adb devices reported.</div>
        ) : (
          devices.map((device) => (
            <div key={device.serial} className={device.current ? "device-row current" : "device-row"}>
              <span>{device.serial}</span>
              <code>{device.current ? "streaming" : device.state}</code>
            </div>
          ))
        )}
      </div>
      <button onClick={() => void refresh()}>Refresh Devices</button>
      <div className="panel-heading">
        <h2>Orientation</h2>
        <div className="location-status">{orientationStatus}</div>
      </div>
      <div className="segmented-row">
        <button
          className={orientation === "portrait" ? "selected" : ""}
          onClick={() => void setDeviceOrientation("portrait")}
        >
          Portrait
        </button>
        <button
          className={orientation === "landscape" ? "selected" : ""}
          onClick={() => void setDeviceOrientation("landscape")}
        >
          Landscape
        </button>
        <button
          className={orientation === "auto" ? "selected" : ""}
          onClick={() => void setDeviceOrientation("auto")}
        >
          Auto
        </button>
      </div>
    </section>
  );
}
