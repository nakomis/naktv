import { useCallback, useEffect, useRef, useState } from 'react';
import { go2rtcUrls } from '../../config';

export type FeedMode = 'video' | 'mjpeg';

export interface VideoFeedConfig {
  videoTimeoutMs: number;
  videoRetryMs: number;
}

export interface VideoFeedState {
  mode: FeedMode;
  /** go2rtc MSE endpoint while in video mode; undefined once we've given up. */
  mseUrl: string | undefined;
  /** Video element is playing frames. */
  onPlaying: () => void;
  /** Video element failed — fall back now rather than waiting for the timer. */
  onError: () => void;
}

/**
 * Chooses between go2rtc's H.264 stream and Leia's MJPEG.
 *
 * H.264 over MSE is tried first: the TV decodes it in hardware, so it is
 * smooth where MJPEG stutters, and MSE is the only transport it will play the
 * muxed Spotify audio track from as well. go2rtc runs on phi, a workstation that sleeps, so a feed
 * that doesn't start playing within `videoTimeoutMs` drops to MJPEG and is
 * retried every `videoRetryMs` — the picture is worse but it is always there.
 *
 * `host` is a dependency, so changing it in Settings re-tries H.264 at once.
 */
export function useVideoFeed(config: VideoFeedConfig, host: string): VideoFeedState {
  const [mode, setMode] = useState<FeedMode>('video');
  const [mseUrl, setMseUrl] = useState<string | undefined>(go2rtcUrls(host).mseUrl);

  const timeoutTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const playing = useRef(false);

  const clearTimers = useCallback(() => {
    clearTimeout(timeoutTimer.current);
    clearTimeout(retryTimer.current);
    timeoutTimer.current = undefined;
    retryTimer.current = undefined;
  }, []);

  const fallBack = useCallback(() => {
    clearTimers();
    playing.current = false;
    setMode('mjpeg');
    setMseUrl(undefined);
    retryTimer.current = setTimeout(() => {
      setMode('video');
      setMseUrl(go2rtcUrls(host).mseUrl);
    }, config.videoRetryMs);
  }, [clearTimers, config.videoRetryMs, host]);

  const onPlaying = useCallback(() => {
    playing.current = true;
    clearTimeout(timeoutTimer.current);
    timeoutTimer.current = undefined;
  }, []);

  useEffect(() => {
    // A new host means a new go2rtc: start again from H.264.
    clearTimers();
    playing.current = false;
    setMode('video');
    setMseUrl(go2rtcUrls(host).mseUrl);
    return clearTimers;
  }, [host, clearTimers]);

  useEffect(() => {
    if (mode !== 'video' || !mseUrl) return;
    timeoutTimer.current = setTimeout(() => {
      if (!playing.current) fallBack();
    }, config.videoTimeoutMs);
    return () => clearTimeout(timeoutTimer.current);
  }, [mode, mseUrl, config.videoTimeoutMs, fallBack]);

  return { mode, mseUrl, onPlaying, onError: fallBack };
}
