import { useCallback, useEffect, useRef, useState } from 'react';
import { go2rtcUrls } from '../../config';
import { usePageVisible } from './usePageVisible';

export type FeedMode = 'video' | 'mjpeg';

export interface VideoFeedConfig {
  /** go2rtc stream name, e.g. `printer_av` or `resin_av`. */
  streamName: string;
  videoTimeoutMs: number;
  videoRetryMs: number;
  reconnectDelayMs: number;
}

/**
 * Reconnects to MSE before giving up on it.
 *
 * go2rtc restarts its producers whenever the last consumer drops, and the
 * stream then simply stops arriving — the socket stays open, so nothing fires
 * an error. mseClient's watchdog spots the stall, and reconnecting recovers it
 * in a couple of seconds. Without this the picture freezes until the app is
 * relaunched by hand.
 */
const MAX_VIDEO_RETRIES = 3;

export interface VideoFeedState {
  mode: FeedMode;
  /** go2rtc MSE endpoint while in video mode; undefined once we've given up. */
  mseUrl: string | undefined;
  /**
   * The app is in the foreground. While it isn't, nothing may hold a
   * connection to go2rtc (NAKTV-8).
   */
  visible: boolean;
  /** Back from the background, and the video has not started playing again yet. */
  resuming: boolean;
  /** Video element is playing frames. */
  onPlaying: () => void;
  /** Video element failed — fall back now rather than waiting for the timer. */
  onError: () => void;
}

/**
 * Chooses between go2rtc's H.264 stream and a camera's MJPEG fallback.
 *
 * H.264 over MSE is tried first: the TV decodes it in hardware, so it is
 * smooth where MJPEG stutters, and MSE is the only transport it will play the
 * muxed Spotify audio track from as well. go2rtc runs on phi, a workstation
 * that sleeps, so a feed that doesn't start playing within `videoTimeoutMs`
 * drops to MJPEG and is retried every `videoRetryMs` — the picture is worse
 * but it is always there.
 *
 * Every timer stops while the app is in the background (NAKTV-8), so a hidden
 * app neither falls back nor retries; the caller drops the connection itself.
 * On return the timeout starts afresh, with a full set of retries.
 *
 * `host` is a dependency, so changing it in Settings re-tries H.264 at once.
 * `config.streamName` picks which go2rtc producer this instance plays —
 * `printer_av` or `resin_av` — shared plumbing, different camera.
 */
export function useVideoFeed(config: VideoFeedConfig, host: string): VideoFeedState {
  const visible = usePageVisible();
  const [mode, setMode] = useState<FeedMode>('video');
  const [mseUrl, setMseUrl] = useState<string | undefined>(
    go2rtcUrls(config.streamName, host).mseUrl,
  );
  const [resuming, setResuming] = useState(false);

  const timeoutTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const playing = useRef(false);
  const retries = useRef(0);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const clearTimers = useCallback(() => {
    clearTimeout(timeoutTimer.current);
    clearTimeout(retryTimer.current);
    timeoutTimer.current = undefined;
    retryTimer.current = undefined;
  }, []);

  const fallBack = useCallback(() => {
    // A connection let go for the background has not failed.
    if (!visibleRef.current) return;
    clearTimers();
    playing.current = false;

    if (retries.current < MAX_VIDEO_RETRIES) {
      retries.current += 1;
      // The query is ignored by go2rtc; it exists to change the string, so the
      // effect that owns the connection tears the old one down and reconnects.
      const attempt = retries.current;
      retryTimer.current = setTimeout(() => {
        setMseUrl(`${go2rtcUrls(config.streamName, host).mseUrl}&_r=${attempt}`);
      }, config.reconnectDelayMs);
      return;
    }

    setMode('mjpeg');
    setMseUrl(undefined);
    setResuming(false);
  }, [clearTimers, config.reconnectDelayMs, config.streamName, host]);

  const onPlaying = useCallback(() => {
    playing.current = true;
    retries.current = 0;
    clearTimeout(timeoutTimer.current);
    timeoutTimer.current = undefined;
    setResuming(false);
  }, []);

  useEffect(() => {
    // A new host or stream means a new go2rtc producer: start again from H.264.
    clearTimers();
    playing.current = false;
    retries.current = 0;
    setMode('video');
    setMseUrl(go2rtcUrls(config.streamName, host).mseUrl);
    return clearTimers;
  }, [host, config.streamName, clearTimers]);

  // Backgrounded: stop the clocks. Whatever was playing has to start again on
  // return, and gets a full set of retries to do it.
  useEffect(() => {
    if (visible) return;
    clearTimers();
    playing.current = false;
    retries.current = 0;
    setResuming(true);
  }, [visible, clearTimers]);

  useEffect(() => {
    if (!visible || mode !== 'video' || !mseUrl) return;
    timeoutTimer.current = setTimeout(() => {
      if (!playing.current) fallBack();
    }, config.videoTimeoutMs);
    return () => clearTimeout(timeoutTimer.current);
  }, [visible, mode, mseUrl, config.videoTimeoutMs, fallBack]);

  // On the fallback, try H.264 again now and then. Paused in the background,
  // so the spell on MJPEG starts again on return.
  useEffect(() => {
    if (!visible || mode !== 'mjpeg') return;
    const timer = setTimeout(() => {
      retries.current = 0;
      setResuming(false);
      setMode('video');
      setMseUrl(go2rtcUrls(config.streamName, host).mseUrl);
    }, config.videoRetryMs);
    return () => clearTimeout(timer);
  }, [visible, mode, config.videoRetryMs, config.streamName, host]);

  return { mode, mseUrl, visible, resuming, onPlaying, onError: fallBack };
}
