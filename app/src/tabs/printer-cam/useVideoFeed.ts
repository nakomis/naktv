import { useCallback, useEffect, useRef, useState } from 'react';
import { go2rtcUrls } from '../../config';

export type FeedMode = 'video' | 'mjpeg';

export interface VideoFeedConfig {
  videoTimeoutMs: number;
  videoRetryMs: number;
}

export interface VideoFeedState {
  mode: FeedMode;
  /** MP4 source while in video mode; undefined once we've given up on it. */
  videoSrc: string | undefined;
  /** Video element is playing frames. */
  onPlaying: () => void;
  /** Video element failed — fall back now rather than waiting for the timer. */
  onError: () => void;
}

/**
 * Chooses between go2rtc's H.264 stream and Leia's MJPEG.
 *
 * H.264 is tried first: the TV decodes it in hardware, so it is smooth where
 * MJPEG stutters. go2rtc runs on phi, a workstation that sleeps, so a feed
 * that doesn't start playing within `videoTimeoutMs` drops to MJPEG and is
 * retried every `videoRetryMs` — the picture is worse but it is always there.
 *
 * `host` is a dependency, so changing it in Settings re-tries H.264 at once.
 */
export function useVideoFeed(config: VideoFeedConfig, host: string): VideoFeedState {
  const [mode, setMode] = useState<FeedMode>('video');
  const [videoSrc, setVideoSrc] = useState<string | undefined>(go2rtcUrls(host).mp4Url);

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
    setVideoSrc(undefined);
    retryTimer.current = setTimeout(() => {
      setMode('video');
      // Cache-bust so a failed connection isn't served from the media cache.
      setVideoSrc(`${go2rtcUrls(host).mp4Url}&_t=${Date.now()}`);
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
    setVideoSrc(go2rtcUrls(host).mp4Url);
    return clearTimers;
  }, [host, clearTimers]);

  useEffect(() => {
    if (mode !== 'video' || !videoSrc) return;
    timeoutTimer.current = setTimeout(() => {
      if (!playing.current) fallBack();
    }, config.videoTimeoutMs);
    return () => clearTimeout(timeoutTimer.current);
  }, [mode, videoSrc, config.videoTimeoutMs, fallBack]);

  return { mode, videoSrc, onPlaying, onError: fallBack };
}
