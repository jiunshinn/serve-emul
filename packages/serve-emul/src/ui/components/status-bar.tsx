import type { DeviceSize } from "../lib/use-stream";

type Props = {
  status: string;
  deviceSize: DeviceSize | null;
  fps: number;
};

export function StatusBar({ status, deviceSize, fps }: Props) {
  const frameRate = status === "streaming" && fps === 0 ? "idle" : `${fps} fps`;
  const meta =
    status +
    (deviceSize ? ` • ${deviceSize.width}×${deviceSize.height} • ${frameRate}` : "");
  return (
    <header>
      <h1>serve-emul</h1>
      <div className="meta">{meta}</div>
    </header>
  );
}
