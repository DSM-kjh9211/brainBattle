import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { JoinSessionPayload, ServerEnvelope, ServerEventType } from '@brainbattle/shared';
import { BattleSocket, type SocketStatus } from './battleSocket';
import { wsUrl } from './api';

type Env = ServerEnvelope<ServerEventType>;

export interface UseBattleOptions<S> {
  enabled: boolean;
  join: (epochId: string) => JoinSessionPayload;
  reducer: (s: S | null, env: Env) => S | null;
  pendingKey?: string | null;
  /** session id, if known: load-balancer routing hint */
  routeKey?: string | null;
  onEvent?: (env: Env, socket: BattleSocket) => void;
}

/**
 * React binding of BattleSocket: state is ONLY derived from server events; the UI never computes
 * scores, ranks or submission state on its own.
 */
export function useBattle<S>(opts: UseBattleOptions<S>) {
  const [state, dispatch] = useReducer((s: S | null, env: Env) => opts.reducer(s, env), null);
  const [status, setStatus] = useState<SocketStatus>('idle');
  const [fatal, setFatal] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const socketRef = useRef<BattleSocket | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (!opts.enabled) return;
    const socket = new BattleSocket({
      url: wsUrl(opts.routeKey),
      join: (epoch) => optsRef.current.join(epoch),
      pendingKey: opts.pendingKey ?? null,
      onEvent: (env) => {
        dispatch(env);
        optsRef.current.onEvent?.(env, socket);
        setPendingCount(socket.pending?.size ?? 0);
      },
      onStatus: (s, detail) => {
        setStatus(s);
        if (s === 'fatal') setFatal(detail ?? 'ERROR');
        setPendingCount(socket.pending?.size ?? 0);
      },
    });
    socketRef.current = socket;
    socket.start();
    return () => socket.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.enabled, opts.pendingKey]);

  const refreshPending = useCallback(() => setPendingCount(socketRef.current?.pending?.size ?? 0), []);

  return { state, status, fatal, socket: socketRef, pendingCount, refreshPending };
}

/** Re-renders every `ms` and returns the estimated server time. */
export function useServerNow(socket: React.MutableRefObject<BattleSocket | null>, ms = 250): number {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
  return socket.current?.serverNow() ?? Date.now();
}
