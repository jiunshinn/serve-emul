import type { DeviceSize, StreamStats } from "../lib/use-stream";

type Props = {
  status: string;
  deviceSize: DeviceSize | null;
  fps: number;
  stats?: StreamStats | null;
};

export function StatusBar({ status, deviceSize, fps, stats }: Props) {
  const frameRate = status === "streaming" && fps === 0 ? "idle" : `${fps} fps`;
  const latency = stats?.e2eMs != null ? ` • ${Math.round(stats.e2eMs)}ms` : "";
  const meta =
    status +
    (deviceSize ? ` • ${deviceSize.width}×${deviceSize.height} • ${frameRate}${latency}` : "");
  const detail = stats
    ? [
        stats.transitMs != null ? `transit ${stats.transitMs}ms` : null,
        stats.e2eMs != null ? `server→glass ${stats.e2eMs}ms` : null,
        `decode queue ${stats.decodeQueue}`,
        stats.codec,
      ]
        .filter(Boolean)
        .join(" • ")
    : undefined;
  return (
    <header>
      <h1>serve-emul</h1>
      <div className="meta" title={detail}>{meta}</div>
    </header>
  );
}
