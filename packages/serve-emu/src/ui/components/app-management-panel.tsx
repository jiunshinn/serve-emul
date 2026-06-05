import { useRef, useState } from "react";

type AppApiResult = {
  ok?: boolean;
  output?: string;
  error?: string;
};

async function postJson(path: string, body: Record<string, unknown>): Promise<AppApiResult> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await res.json() as AppApiResult;
}

function outputFor(result: AppApiResult): string {
  return result.ok ? result.output || "OK" : result.error || "Failed";
}

export function AppManagementPanel() {
  const apkRef = useRef<HTMLInputElement>(null);
  const [packageName, setPackageName] = useState("");
  const [activity, setActivity] = useState("");
  const [permission, setPermission] = useState("android.permission.POST_NOTIFICATIONS");
  const [status, setStatus] = useState("Ready");

  const run = async (label: string, request: () => Promise<AppApiResult>) => {
    setStatus(`${label}...`);
    try {
      const result = await request();
      setStatus(outputFor(result));
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const install = async () => {
    const file = apkRef.current?.files?.[0];
    if (!file) {
      setStatus("Choose an APK first");
      return;
    }
    await run("Installing", async () => {
      const form = new FormData();
      form.set("apk", file);
      const res = await fetch("/api/apps/install", { method: "POST", body: form });
      return await res.json() as AppApiResult;
    });
    if (apkRef.current) apkRef.current.value = "";
  };

  const packageBody = () => ({ packageName: packageName.trim() });

  return (
    <section className="tool-panel app-management-panel">
      <div className="panel-heading">
        <h2>Apps</h2>
        <div className="location-status">{status}</div>
      </div>
      <input ref={apkRef} type="file" accept=".apk,application/vnd.android.package-archive" />
      <button className="primary-action" onClick={() => void install()}>
        Install APK
      </button>
      <label className="stacked-field">
        Package
        <input
          onChange={(e) => setPackageName(e.currentTarget.value)}
          placeholder="com.example.app"
          value={packageName}
        />
      </label>
      <label className="stacked-field">
        Activity
        <input
          onChange={(e) => setActivity(e.currentTarget.value)}
          placeholder=".MainActivity"
          value={activity}
        />
      </label>
      <div className="panel-actions app-actions">
        <button
          onClick={() =>
            void run("Launching", () =>
              postJson("/api/apps/launch", { ...packageBody(), activity: activity.trim() || undefined }),
            )
          }
        >
          Launch
        </button>
        <button onClick={() => void run("Clearing", () => postJson("/api/apps/clear", packageBody()))}>
          Clear
        </button>
        <button
          onClick={() => void run("Stopping", () => postJson("/api/apps/force-stop", packageBody()))}
        >
          Stop
        </button>
      </div>
      <label className="stacked-field">
        Permission
        <input
          onChange={(e) => setPermission(e.currentTarget.value)}
          placeholder="android.permission.POST_NOTIFICATIONS"
          value={permission}
        />
      </label>
      <button
        onClick={() =>
          void run("Granting", () =>
            postJson("/api/apps/grant", { ...packageBody(), permission: permission.trim() }),
          )
        }
      >
        Grant Permission
      </button>
    </section>
  );
}
