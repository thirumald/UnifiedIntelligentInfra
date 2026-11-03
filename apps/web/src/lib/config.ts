/** Browser-visible configuration (inlined at build time). */
const [lon, lat, zoom] = (process.env.NEXT_PUBLIC_MAP_CENTER ?? '54.3773,24.4539,16').split(',').map(Number);

const wsUrl = new URL(process.env.NEXT_PUBLIC_WS_URL ?? 'http://localhost:8082/dt/realtime');

export const config = {
  apiUrl: (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8082/dt/v1').replace(/\/$/, ''),
  /** socket.io server origin + path (gateway context + /socket.io) */
  wsOrigin: wsUrl.origin,
  wsPath: `${wsUrl.pathname.replace(/\/$/, '')}/socket.io`,
  mapStyleUrl: process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? 'https://tiles.openfreemap.org/styles/liberty',
  mapCenter: { lon: lon ?? 54.3773, lat: lat ?? 24.4539, zoom: zoom ?? 16 },
};
