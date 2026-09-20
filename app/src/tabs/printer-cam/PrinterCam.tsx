import { CONFIG } from '../../config';
import { getSettings } from '../../settings';
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

  return (
    <div className="printer-cam">
      {video.mode === 'video' && video.videoSrc ? (
        <video
          // muted + autoPlay + playsInline is what lets webOS start it unattended.
          src={video.videoSrc}
          autoPlay
          muted
          playsInline
          aria-label="3D printer camera"
          onPlaying={video.onPlaying}
          onError={video.onError}
        />
      ) : (
        <MjpegFeed />
      )}
    </div>
  );
}
