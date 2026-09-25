import { useEffect, useState } from 'react';
import { CONFIG, nowPlayingUrl } from '../../config';
import type { NowPlayingDisplay } from './nowPlaying';
import { toNowPlayingDisplay } from './nowPlaying';

/**
 * Polls phi's `now-playing.json` (written by `feed/bin/now-playing.py`, a
 * librespot `--onevent` hook) for what Spotify is currently playing.
 *
 * Same shape as useCthulhu: each poll carries its own timeout, an `inFlight`
 * guard stops a slow poll overlapping the next tick, and polling stops
 * entirely when the overlay is off. A missing or broken feed is not an error
 * worth shouting about — it just means nothing is shown.
 */
export function useNowPlaying(enabled: boolean): NowPlayingDisplay | null {
  const [nowPlaying, setNowPlaying] = useState<NowPlayingDisplay | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let inFlight = false;
    const { pollIntervalMs, timeoutMs } = CONFIG.nowPlaying;

    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(nowPlayingUrl(), {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!cancelled) setNowPlaying(toNowPlayingDisplay(data));
      } catch {
        // Unreachable, timed out, or malformed — quietly show nothing rather
        // than freezing on a track that has stopped being true.
        if (!cancelled) setNowPlaying(null);
      } finally {
        clearTimeout(timer);
        inFlight = false;
      }
    };

    void poll();
    const interval = setInterval(poll, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [enabled]);

  return nowPlaying;
}
