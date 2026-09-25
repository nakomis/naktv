import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef } from 'react';
import { getSettings } from '../../settings';
import type { LiveEdgeConfig } from './liveEdge';
import { seekToLiveEdge } from './liveEdge';
import { connectMse } from './mseClient';
import type { FeedConfig } from './useMjpegFeed';
import { useMjpegFeed } from './useMjpegFeed';
import type { VideoFeedConfig } from './useVideoFeed';
import { useVideoFeed } from './useVideoFeed';

/**
 * Everything one camera tab needs: which go2rtc producer to play, its MJPEG
 * fallback, and how the live-edge chase behaves. `printer-cam` and `elegoo`
 * each supply their own values (see config.ts's `printerCam`/`elegooCam`) —
 * the mechanics below don't care which camera is on the other end.
 */
export interface CameraFeedConfig extends VideoFeedConfig, FeedConfig, LiveEdgeConfig {
  /** How often to check the live-edge lag; see liveEdge.ts. */
  liveEdgeCheckMs: number;
}

/**
 * The MJPEG fallback, in its own component so its hook only runs while it is
 * on screen — mounted alongside the video it would hold a second connection
 * to the source, at a much higher bitrate than the stream being watched.
 */
function MjpegFeed({ config, ariaLabel }: { config: FeedConfig; ariaLabel: string }) {
  const feed = useMjpegFeed(config);
  return (
    <>
      {feed.src && (
        <img src={feed.src} alt={ariaLabel} onLoad={feed.onLoad} onError={feed.onError} />
      )}
      {feed.status && (
        <div className="feed-status" role="status">
          <span className="dot" />
          {feed.status}
        </div>
      )}
    </>
  );
}

export interface CameraFeedProps {
  /** Stream name, MJPEG fallback and live-edge tuning for this camera. */
  config: CameraFeedConfig;
  /** Accessible name for the video/image element, e.g. "3D printer camera". */
  ariaLabel: string;
  /** Rendered over the top of the feed — a status overlay, or nothing. */
  overlay?: ReactNode;
}

/**
 * Plays a go2rtc H.264 stream with a Spotify-muxed audio track, falling back
 * to an MJPEG source when H.264 doesn't start.
 *
 * Shared by every camera tab (originally written for the FDM printer cam,
 * NAKTV-13 added the Elegoo resin printer alongside it): the MSE plumbing,
 * live-edge chase and MJPEG degrade are all generic, only `config` and the
 * overlay content differ per camera.
 */
export function CameraFeed({ config, ariaLabel, overlay }: CameraFeedProps) {
  const video = useVideoFeed(config, getSettings().go2rtcHost);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // The element has to start muted or webOS won't autoplay it unattended, but
  // the stream carries a Spotify audio track that a muted element would throw
  // away. So unmute once frames are actually flowing. Doing it on `playing`
  // rather than up front keeps the autoplay behaviour that got us here.
  const handlePlaying = useCallback(() => {
    video.onPlaying();
    const element = videoRef.current;
    if (element) element.muted = false;
  }, [video]);

  // The feed arrives over MSE rather than as a plain src: it is the only
  // transport this TV plays both the video and the muxed audio from.
  useEffect(() => {
    const element = videoRef.current;
    if (video.mode !== 'video' || !video.mseUrl || !element) return;
    const connection = connectMse(element, video.mseUrl, { onError: video.onError });
    return () => connection.close();
  }, [video.mode, video.mseUrl, video.onError]);

  // Keep the player near the live edge; see liveEdge.ts for why it drifts.
  useEffect(() => {
    if (video.mode !== 'video') return;
    const timer = setInterval(() => {
      const element = videoRef.current;
      if (element) seekToLiveEdge(element, config);
    }, config.liveEdgeCheckMs);
    return () => clearInterval(timer);
  }, [video.mode, config]);

  return (
    <div className="camera-feed">
      {overlay}
      {video.mode === 'video' && video.mseUrl ? (
        <video
          ref={videoRef}
          // No src: connectMse attaches the MediaSource. muted + autoPlay +
          // playsInline is what lets webOS start it unattended, and
          // handlePlaying unmutes it again once it has.
          autoPlay
          muted
          playsInline
          aria-label={ariaLabel}
          onPlaying={handlePlaying}
          onError={video.onError}
        />
      ) : (
        <MjpegFeed config={config} ariaLabel={ariaLabel} />
      )}
    </div>
  );
}
