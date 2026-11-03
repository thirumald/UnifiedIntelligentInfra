'use client';

import { MapboxOverlay } from '@deck.gl/mapbox';
import { PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { PickingInfo } from '@deck.gl/core';
import type { AssetFeature } from '@dt/contracts';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BimModel } from '@/lib/api';
import { config } from '@/lib/config';
import { assetStatus, useTwin } from '@/lib/store';
import { STATUS_COLORS } from '@/lib/theme';

const M_PER_DEG_LAT = 110_540;
const mPerDegLon = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

/** Building envelope polygon (lon/lat ring) from a BIM model's origin, size and rotation */
function footprint(m: BimModel): [number, number][] {
  const hw = m.widthM / 2;
  const hd = m.depthM / 2;
  const r = (-m.rotationDeg * Math.PI) / 180;
  return [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
    [-hw, -hd],
  ].map(([x, y]) => {
    const xr = x! * Math.cos(r) - y! * Math.sin(r);
    const yr = x! * Math.sin(r) + y! * Math.cos(r);
    return [m.lon + xr / mPerDegLon(m.lat), m.lat + yr / M_PER_DEG_LAT];
  });
}

/** Markers stay visible through translucent extruded buildings */
const ON_TOP = { depthCompare: 'always' } as const;

interface MarkerDatum {
  asset: AssetFeature;
  position: [number, number, number];
  color: [number, number, number];
  critical: boolean;
}

/**
 * GIS viewport — MapLibre GL basemap (token-free, self-hostable) with a
 * deck.gl overlay interleaved into the WebGL context:
 *   • PolygonLayer   extruded BIM building envelopes (click → BIM view)
 *   • ScatterplotLayer asset markers coloured by live device status
 *   • ScatterplotLayer animated halo on critical assets
 *   • TextLayer      labels at street zoom
 */
export default function MapView() {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const [zoom, setZoom] = useState(config.mapCenter.zoom);
  const [pulse, setPulse] = useState(0);
  const [hover, setHover] = useState<{ x: number; y: number; asset: AssetFeature } | null>(null);

  const assets = useTwin((s) => s.assets);
  const devices = useTwin((s) => s.devices);
  const version = useTwin((s) => s.version);
  const models = useTwin((s) => s.models);
  const selectedId = useTwin((s) => s.selectedAssetId);
  const filter = useTwin((s) => s.filter);

  // ---- Map lifecycle ---------------------------------------------------------
  useEffect(() => {
    if (!container.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: container.current,
      style: config.mapStyleUrl,
      center: [config.mapCenter.lon, config.mapCenter.lat],
      zoom: config.mapCenter.zoom,
      pitch: 55,
      bearing: -20,
      maxPitch: 75,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
    const overlay = new MapboxOverlay({ interleaved: true, layers: [] });
    map.addControl(overlay);
    map.on('zoomend', () => setZoom(map.getZoom()));
    mapRef.current = map;
    overlayRef.current = overlay;
    return () => {
      overlay.finalize();
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
  }, []);

  // ---- Derived marker data (recomputed on live updates) -----------------------
  const markers = useMemo<MarkerDatum[]>(() => {
    const text = filter.text.trim().toLowerCase();
    return assets
      .filter((a) => a.properties.type !== 'building')
      .filter((a) => !filter.domain || a.properties.domain === filter.domain)
      .filter((a) => !text || a.properties.name.toLowerCase().includes(text) || (a.properties.externalId ?? '').toLowerCase().includes(text))
      .map((a) => {
        const status = assetStatus(a, devices);
        const [lon, lat, alt] = a.geometry.coordinates;
        return { asset: a, position: [lon, lat, (alt ?? 0) + 1] as [number, number, number], color: STATUS_COLORS[status].rgb, critical: status === 'critical' };
      })
      .filter((m) => !filter.onlyAlerts || m.critical || assetStatus(m.asset, devices) === 'warning');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, version, filter]);

  const hasCritical = markers.some((m) => m.critical);

  // Halo animation only runs while something is critical
  useEffect(() => {
    if (!hasCritical) return;
    let raf = 0;
    const tick = (t: number) => {
      setPulse((t / 1000) % 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hasCritical]);

  // ---- Frame every asset on first load ----------------------------------------
  const framed = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || framed.current || assets.length === 0) return;
    const bounds = new maplibregl.LngLatBounds();
    for (const a of assets) bounds.extend([a.geometry.coordinates[0], a.geometry.coordinates[1]]);
    const fit = () => map.fitBounds(bounds, { padding: 80, pitch: 55, bearing: -20, maxZoom: 18.5, duration: 0 });
    if (map.loaded()) fit();
    else map.once('load', fit);
    framed.current = true;
  }, [assets]);

  // ---- Fly to selection -------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    const a = selectedId ? useTwin.getState().assetsById.get(selectedId) : null;
    if (!map || !a) return;
    const [lon, lat] = a.geometry.coordinates;
    map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 18), speed: 1.2 });
  }, [selectedId]);

  // ---- Layers -------------------------------------------------------------------
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const { select, selectModel, setView } = useTwin.getState();

    overlay.setProps({
      layers: [
        new PolygonLayer<BimModel>({
          id: 'bim-envelopes',
          data: models,
          getPolygon: (m) => footprint(m),
          extruded: true,
          wireframe: true,
          getElevation: (m) => Math.max(...m.storeys.map((s) => s.elevation_m + s.height_m), 6),
          getFillColor: [96, 140, 210, 70],
          getLineColor: [160, 190, 240, 200],
          pickable: true,
          autoHighlight: true,
          highlightColor: [120, 170, 255, 110],
          onClick: (info: PickingInfo<BimModel>) => {
            if (!info.object) return;
            selectModel(info.object.id);
            setView('bim');
          },
        }),
        new ScatterplotLayer<MarkerDatum>({
          id: 'critical-halo',
          data: markers.filter((m) => m.critical),
          getPosition: (d) => d.position,
          getRadius: 4 + pulse * 10,
          radiusUnits: 'meters',
          radiusMinPixels: 8 + pulse * 14,
          stroked: true,
          filled: false,
          getLineColor: [239, 68, 68, Math.round(255 * (1 - pulse))],
          lineWidthMinPixels: 2,
          parameters: ON_TOP,
          updateTriggers: { getRadius: pulse, getLineColor: pulse },
        }),
        new ScatterplotLayer<MarkerDatum>({
          id: 'assets',
          data: markers,
          getPosition: (d) => d.position,
          getFillColor: (d) => [...d.color, 235] as [number, number, number, number],
          getLineColor: (d) => (d.asset.id === selectedId ? [255, 255, 255, 255] : [12, 18, 28, 220]),
          getLineWidth: (d) => (d.asset.id === selectedId ? 3 : 1.5),
          lineWidthUnits: 'pixels',
          stroked: true,
          getRadius: 2.2,
          radiusUnits: 'meters',
          radiusMinPixels: 6,
          radiusMaxPixels: 22,
          pickable: true,
          onClick: (info: PickingInfo<MarkerDatum>) => info.object && select(info.object.asset.id),
          onHover: (info: PickingInfo<MarkerDatum>) => setHover(info.object ? { x: info.x, y: info.y, asset: info.object.asset } : null),
          parameters: ON_TOP,
          updateTriggers: { getFillColor: version, getLineColor: selectedId, getLineWidth: selectedId },
        }),
        new TextLayer<MarkerDatum>({
          id: 'labels',
          data: zoom >= 18 ? markers : [],
          getPosition: (d) => d.position,
          getText: (d) => d.asset.properties.externalId ?? d.asset.properties.name,
          getSize: 11,
          getColor: [230, 236, 245, 255],
          getPixelOffset: [0, -16],
          background: true,
          getBackgroundColor: [12, 18, 28, 200],
          backgroundPadding: [4, 2],
          fontFamily: 'Inter, system-ui, sans-serif',
          characterSet: 'auto',
        }),
      ],
    });
  }, [markers, models, selectedId, zoom, pulse, version]);

  const hoverStatus = hover ? assetStatus(hover.asset, devices) : null;

  return (
    <div className="viewport">
      <div ref={container} className="map-canvas" />
      {hover && hoverStatus && (
        <div className="map-tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <strong>{hover.asset.properties.name}</strong>
          <span style={{ color: STATUS_COLORS[hoverStatus].css }}>● {STATUS_COLORS[hoverStatus].label}</span>
          <span className="muted">{hover.asset.properties.type.replace(/_/g, ' ')}</span>
        </div>
      )}
      <div className="legend">
        {(['normal', 'warning', 'critical', 'offline', 'unknown'] as const).map((s) => (
          <span key={s}>
            <i style={{ background: STATUS_COLORS[s].css }} /> {STATUS_COLORS[s].label}
          </span>
        ))}
      </div>
    </div>
  );
}
