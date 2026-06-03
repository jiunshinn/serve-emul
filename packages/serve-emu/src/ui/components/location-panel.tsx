import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent } from "react";

type Point = { x: number; y: number };
type LocationPoint = { latitude: number; longitude: number };
type Tile = { key: string; x: number; y: number; left: number; top: number; wrappedX: number };

const TILE_SIZE = 256;
const MIN_ZOOM = 2;
const MAX_ZOOM = 18;
const DEFAULT_LOCATION: LocationPoint = { latitude: 37.5665, longitude: 126.978 };
const DEFAULT_SIZE = { width: 320, height: 220 };

const PRESETS: (LocationPoint & { label: string })[] = [
  { label: "Seoul", latitude: 37.5665, longitude: 126.978 },
  { label: "London", latitude: 51.5072, longitude: -0.1276 },
  { label: "SF", latitude: 37.7749, longitude: -122.4194 },
];

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function wrapLongitude(longitude: number): number {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

function worldSize(zoom: number): number {
  return TILE_SIZE * 2 ** zoom;
}

function project(location: LocationPoint, zoom: number): Point {
  const sin = Math.sin((clamp(location.latitude, -85.05112878, 85.05112878) * Math.PI) / 180);
  const size = worldSize(zoom);
  return {
    x: ((wrapLongitude(location.longitude) + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
  };
}

function unproject(point: Point, zoom: number): LocationPoint {
  const size = worldSize(zoom);
  const lng = (point.x / size) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * point.y) / size;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return {
    latitude: clamp(lat, -85.05112878, 85.05112878),
    longitude: wrapLongitude(lng),
  };
}

function formatCoord(n: number): string {
  return n.toFixed(6);
}

function normalizedTileX(x: number, zoom: number): number {
  const count = 2 ** zoom;
  return ((x % count) + count) % count;
}

function tileUrl(tile: Tile, zoom: number): string {
  return `https://tile.openstreetmap.org/${zoom}/${tile.wrappedX}/${tile.y}.png`;
}

export function LocationPanel() {
  const mapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ start: Point; center: Point; moved: boolean } | null>(null);
  const [size, setSize] = useState(DEFAULT_SIZE);
  const [zoom, setZoom] = useState(12);
  const [center, setCenter] = useState<LocationPoint>(DEFAULT_LOCATION);
  const [draft, setDraft] = useState<LocationPoint>(DEFAULT_LOCATION);
  const [latText, setLatText] = useState(formatCoord(DEFAULT_LOCATION.latitude));
  const [lngText, setLngText] = useState(formatCoord(DEFAULT_LOCATION.longitude));
  const [status, setStatus] = useState("Ready");

  const syncDraft = useCallback((next: LocationPoint, recenter = false) => {
    const normalized = {
      latitude: clamp(next.latitude, -85.05112878, 85.05112878),
      longitude: wrapLongitude(next.longitude),
    };
    setDraft(normalized);
    setLatText(formatCoord(normalized.latitude));
    setLngText(formatCoord(normalized.longitude));
    if (recenter) setCenter(normalized);
  }, []);

  useEffect(() => {
    const node = mapRef.current;
    if (!node) return;
    const updateSize = () => {
      const rect = node.getBoundingClientRect();
      setSize({
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    fetch("/api/location")
      .then((r) => r.json())
      .then((data: { location?: LocationPoint | null }) => {
        if (data.location) syncDraft(data.location, true);
      })
      .catch(() => {});
  }, [syncDraft]);

  const centerPixel = useMemo(() => project(center, zoom), [center, zoom]);
  const draftPixel = useMemo(() => project(draft, zoom), [draft, zoom]);

  const tiles = useMemo<Tile[]>(() => {
    const maxTile = 2 ** zoom - 1;
    const leftWorld = centerPixel.x - size.width / 2;
    const topWorld = centerPixel.y - size.height / 2;
    const startX = Math.floor(leftWorld / TILE_SIZE);
    const endX = Math.floor((leftWorld + size.width) / TILE_SIZE);
    const startY = clamp(Math.floor(topWorld / TILE_SIZE), 0, maxTile);
    const endY = clamp(Math.floor((topWorld + size.height) / TILE_SIZE), 0, maxTile);
    const out: Tile[] = [];
    for (let y = startY; y <= endY; y++) {
      for (let x = startX; x <= endX; x++) {
        out.push({
          key: `${zoom}-${x}-${y}`,
          x,
          y,
          wrappedX: normalizedTileX(x, zoom),
          left: x * TILE_SIZE - leftWorld,
          top: y * TILE_SIZE - topWorld,
        });
      }
    }
    return out;
  }, [centerPixel, size.height, size.width, zoom]);

  const locationFromClient = (clientX: number, clientY: number): LocationPoint | null => {
    const node = mapRef.current;
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return unproject(
      {
        x: centerPixel.x + clientX - rect.left - rect.width / 2,
        y: centerPixel.y + clientY - rect.top - rect.height / 2,
      },
      zoom,
    );
  };

  const markerLeft = draftPixel.x - centerPixel.x + size.width / 2;
  const markerTop = draftPixel.y - centerPixel.y + size.height / 2;

  const applyLocation = async (location = draft) => {
    setStatus("Setting...");
    try {
      const res = await fetch("/api/location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          latitude: location.latitude,
          longitude: location.longitude,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || "location update failed");
      setStatus(`Applied ${formatCoord(location.latitude)}, ${formatCoord(location.longitude)}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const applyText = () => {
    const latitude = Number(latText);
    const longitude = Number(lngText);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      setStatus("Coordinates must be numbers");
      return;
    }
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      setStatus("Coordinates are out of range");
      return;
    }
    const next = { latitude, longitude };
    syncDraft(next, true);
    void applyLocation(next);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    mapRef.current?.setPointerCapture(e.pointerId);
    dragRef.current = {
      start: { x: e.clientX, y: e.clientY },
      center: centerPixel,
      moved: false,
    };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.start.x;
    const dy = e.clientY - drag.start.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    setCenter(unproject({ x: drag.center.x - dx, y: drag.center.y - dy }, zoom));
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    try {
      mapRef.current?.releasePointerCapture(e.pointerId);
    } catch {}
    if (drag?.moved) return;
    const next = locationFromClient(e.clientX, e.clientY);
    if (next) syncDraft(next);
  };

  return (
    <aside className="location-panel">
      <div className="panel-heading">
        <h2>Location</h2>
        <div className="location-status">{status}</div>
      </div>
      <div
        className="map"
        ref={mapRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
      >
        {tiles.map((tile) => (
          <img
            alt=""
            className="map-tile"
            draggable={false}
            key={tile.key}
            src={tileUrl(tile, zoom)}
            style={{
              left: tile.left,
              top: tile.top,
            }}
          />
        ))}
        <div
          className="map-marker"
          style={{
            transform: `translate(${markerLeft}px, ${markerTop}px)`,
          }}
        />
        <div className="map-attribution">© OpenStreetMap</div>
      </div>
      <div className="map-controls">
        <button onClick={() => setZoom((z) => clamp(z + 1, MIN_ZOOM, MAX_ZOOM))}>+</button>
        <button onClick={() => setZoom((z) => clamp(z - 1, MIN_ZOOM, MAX_ZOOM))}>-</button>
        <button onClick={() => setCenter(draft)}>Center</button>
      </div>
      <div className="coordinate-grid">
        <label>
          Lat
          <input
            inputMode="decimal"
            onChange={(e) => setLatText(e.currentTarget.value)}
            value={latText}
          />
        </label>
        <label>
          Lng
          <input
            inputMode="decimal"
            onChange={(e) => setLngText(e.currentTarget.value)}
            value={lngText}
          />
        </label>
      </div>
      <div className="preset-row">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            onClick={() => {
              syncDraft(preset, true);
            }}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <button className="primary-action" onClick={applyText}>
        Set Location
      </button>
    </aside>
  );
}
