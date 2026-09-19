import { CONFIG } from '../../config';
import { useMjpegFeed } from './useMjpegFeed';

export function PrinterCam() {
  const feed = useMjpegFeed(CONFIG.printerCam);
  return (
    <div className="printer-cam">
      {feed.src && (
        <img src={feed.src} alt="3D printer camera" onLoad={feed.onLoad} onError={feed.onError} />
      )}
      {feed.status && (
        <div className="feed-status" role="status">
          <span className="dot" />
          {feed.status}
        </div>
      )}
    </div>
  );
}
