import { useCallback, useEffect, useRef } from 'react';
import { CONFIG } from '../../config';
import { getSettings } from '../../settings';
import { seekToLiveEdge } from './liveEdge';
import { useMjpegFeed } from './useMjpegFeed';
import { useVideoFeed } from './useVideoFeed';

/**
 * The MJPEG fallback, in its own component so its hook only runs while it is
 * on screen — mounted alongside the video it would hold a second connection
 * to Leia, at roughly three times the bitrate of the stream being watched.
 */
function MjpegFeed() {
  const feed = useMjpegFeed(CONFIG.printerCam);
  return (
    <>
      {feed.src && (
        <img src={feed.src} alt="3D printer camera" onLoad={feed.onLoad} onError={feed.onError} />
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

export function PrinterCam() {
  const video = useVideoFeed(CONFIG.printerCam, getSettings().go2rtcHost);
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

  // Keep the player near the live edge; see liveEdge.ts for why it drifts.
  useEffect(() => {
    if (video.mode !== 'video') return;
    const timer = setInterval(() => {
      const element = videoRef.current;
      if (element) seekToLiveEdge(element, CONFIG.printerCam);
    }, CONFIG.printerCam.liveEdgeCheckMs);
    return () => clearInterval(timer);
  }, [video.mode]);

  return (
    <div className="printer-cam">
      {video.mode === 'video' && video.videoSrc ? (
        <video
          ref={videoRef}
          // muted + autoPlay + playsInline is what lets webOS start it
          // unattended; handlePlaying unmutes it again once it has.
          src={video.videoSrc}
          autoPlay
          muted
          playsInline
          aria-label="3D printer camera"
          onPlaying={handlePlaying}
          onError={video.onError}
        />
      ) : (
        <MjpegFeed />
      )}
    </div>
  );
}
