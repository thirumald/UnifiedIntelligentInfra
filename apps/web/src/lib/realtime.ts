'use client';

import { REALTIME_NAMESPACE, type ClientToServerEvents, type ServerToClientEvents } from '@dt/contracts';
import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';
import { session } from './api';
import { config } from './config';
import { useTwin } from './store';

/**
 * Live digital-twin channel.
 *  - Authenticates with the platform JWT in the handshake.
 *  - On every (re)connect, re-subscribes and receives a full snapshot,
 *    so the scene self-heals after network drops.
 *  - 'state:batch' deltas (≤10 Hz, coalesced server-side) update the store;
 *    map markers and BIM meshes re-colour from the store.
 */
export function useRealtime(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const { applySnapshot, pushAnomaly, setConnection } = useTwin.getState();

    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(`${config.wsOrigin}${REALTIME_NAMESPACE}`, {
      path: config.wsPath,
      auth: { token: session.token ?? '' },
      transports: ['websocket', 'polling'], // try WS first; fall back if the gateway blocks upgrade
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10_000,
    });

    socket.on('connect', () => {
      setConnection('live');
      socket.emit('subscribe', {}, () => undefined);
    });
    socket.on('disconnect', () => setConnection('reconnecting'));
    socket.io.on('reconnect_attempt', () => setConnection('reconnecting'));
    socket.on('connect_error', () => setConnection('offline'));
    socket.on('state:snapshot', (states) => applySnapshot(states, true));
    socket.on('state:batch', (states) => applySnapshot(states));
    socket.on('anomaly', (a) => pushAnomaly(a));
    socket.on('server:error', (e) => {
      if (e.code === 'unauthorized') {
        session.clear();
        window.location.assign('/login');
      }
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [enabled]);
}
