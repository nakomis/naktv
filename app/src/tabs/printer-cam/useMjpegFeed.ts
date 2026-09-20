import { useCallback, useEffect, useRef, useState } from 'react';

export interface FeedConfig {
  streamUrl: string;
  snapshotUrl: string;
  reconnectDelayMs: number;
  maxStreamFailures: number;
  snapshotIntervalMs: number;
  streamRetryMs: number;
}

export interface FeedState {
  /** Current image source, or undefined while paused. */
  src: string | undefined;
  /** Overlay message; null once frames are arriving. */
  status: string | null;
  onLoad: () => void;
  onError: () => void;
}

function cacheBust(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}`;
}

/**
 * Drives an <img> showing an mjpg-streamer feed.
 *
 * The multipart stream is tried first, with a short reconnect delay on error.
 * After `maxStreamFailures` consecutive errors it drops to polling single
 * snapshots — less smooth, but it survives a flaky multipart connection — and
 * periodically tries the stream again. Everything stops while the app is
 * backgrounded, so a hidden app doesn't hold a connection to the printer.
 */
export function useMjpegFeed(config: FeedConfig): FeedState {
  const [src, setSrc] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<string | null>('Connecting to printer…');

  const failures = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const streamRetryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const snapshotTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const stopAll = useCallback(() => {
    clearTimeout(reconnectTimer.current);
    clearTimeout(streamRetryTimer.current);
    clearInterval(snapshotTimer.current);
    reconnectTimer.current = undefined;
    streamRetryTimer.current = undefined;
    snapshotTimer.current = undefined;
  }, []);

  const startStream = useCallback(() => {
    stopAll();
    setStatus('Connecting to printer…');
    setSrc(cacheBust(config.streamUrl));
  }, [config.streamUrl, stopAll]);

  const startSnapshots = useCallback(() => {
    stopAll();
    setStatus('Stream unstable — polling frames…');
    const tick = () => setSrc(cacheBust(config.snapshotUrl));
    tick();
    snapshotTimer.current = setInterval(tick, config.snapshotIntervalMs);
    streamRetryTimer.current = setTimeout(() => {
      failures.current = 0;
      startStream();
    }, config.streamRetryMs);
  }, [config.snapshotUrl, config.snapshotIntervalMs, config.streamRetryMs, stopAll, startStream]);

  const onLoad = useCallback(() => {
    failures.current = 0;
    setStatus(null);
  }, []);

  const onError = useCallback(() => {
    failures.current += 1;
    if (snapshotTimer.current) return; // already polling; the next tick retries
    if (failures.current >= config.maxStreamFailures) {
      startSnapshots();
      return;
    }
    setStatus('Lost connection — retrying…');
    clearTimeout(reconnectTimer.current);
    reconnectTimer.current = setTimeout(startStream, config.reconnectDelayMs);
  }, [config.maxStreamFailures, config.reconnectDelayMs, startSnapshots, startStream]);

  useEffect(() => {
    function onVisibilityChange() {
      if (document.hidden) {
        stopAll();
        setSrc(undefined);
      } else {
        failures.current = 0;
        startStream();
      }
    }
    startStream();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stopAll();
    };
  }, [startStream, stopAll]);

  return { src, status, onLoad, onError };
}
