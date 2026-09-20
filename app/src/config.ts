// Every deployment-specific value lives here.
//
// The camera is a Logitech C922 on Leia, served by mjpg-streamer inside the
// OctoPrint container, LAN-only on host port 8090 (8080 is scrutiny's). The
// *.home.nakomis.com vhosts demand an mTLS client certificate, which a
// sideloaded webOS app cannot present, so the app goes direct.
//
// MJPEG at 1080p is ~28 Mbit/s of full-frame JPEGs, and the TV has to decode
// every one in software — which it does, jerkily. go2rtc on phi re-encodes the
// same feed to H.264 (~8 Mbit/s) that the TV decodes in hardware. phi is a
// workstation and may be asleep, so the MJPEG feed stays as the fallback: it
// is ugly but it is served by a box that is always on.
//
// IPs rather than .local names: webOS doesn't reliably resolve mDNS.
import { getSettings } from './settings';

const LEIA = 'http://172.29.0.32:8090';
const GO2RTC_PORT = 1984;

// `printer_av` is the printer video with a Spotify audio track muxed in, so the
// TV plays both from a single media element. That is not a convenience: webOS
// allows an app exactly one media element, and a <video> and a separate <audio>
// force-pause each other — a platform rule, not a DRM one. See feed/README.md.
//
// `printer` (video only) is still served, and is the right source for anything
// that doesn't want sound.
const GO2RTC_STREAM = 'printer_av';

/** go2rtc URLs for the currently configured host (Settings tab). */
export function go2rtcUrls(host: string = getSettings().go2rtcHost) {
  const base = `http://${host}:${GO2RTC_PORT}`;
  return {
    /**
     * go2rtc's MSE WebSocket. The only transport this TV will play both the
     * video and the muxed Spotify audio from: progressive fMP4 renders no
     * picture once an audio track is present, and HLS is refused outright.
     */
    mseUrl: `ws://${host}:${GO2RTC_PORT}/api/ws?src=${GO2RTC_STREAM}`,
    /** Progressive fMP4. Video-only; kept for the stream without audio. */
    mp4Url: `${base}/api/stream.mp4?src=${GO2RTC_STREAM}`,
    /** Single frame, for the connection check before we commit to the video. */
    frameUrl: `${base}/api/frame.jpeg?src=${GO2RTC_STREAM}`,
  };
}

export const CONFIG = {
  printerCam: {
    streamUrl: `${LEIA}/?action=stream`,
    snapshotUrl: `${LEIA}/?action=snapshot`,
    reconnectDelayMs: 2000,
    /** Consecutive stream failures before dropping to snapshot polling. */
    maxStreamFailures: 5,
    snapshotIntervalMs: 1000,
    /** How long to poll snapshots before trying the proper stream again. */
    streamRetryMs: 5 * 60 * 1000,
    /** How long to wait for H.264 before falling back to MJPEG. */
    videoTimeoutMs: 8000,
    /** How long to sit on the MJPEG fallback before retrying H.264. */
    videoRetryMs: 2 * 60 * 1000,
    /**
     * Lag past which the player skips forward to the live edge.
     *
     * Generous, because over MSE we feed the SourceBuffer ourselves and a seek
     * lands wherever we put it — with no browser-managed buffer to absorb the
     * difference. Chasing hard costs far more than the latency it saves.
     */
    liveEdgeMaxLagMs: 8000,
    /**
     * How far behind the buffered end to land after skipping.
     *
     * Was 300 ms, tuned for progressive MP4 where the browser managed its own
     * buffering. Over MSE that is self-defeating: landing 300 ms from the edge
     * leaves 300 ms of buffer, playback starves immediately, stalls until the
     * buffer refills, then gets seeked back onto the edge to starve again —
     * a loop that looks like the picture hanging a second at a time, forever.
     * Land with real headroom instead.
     */
    liveEdgeTargetMs: 3000,
    /** How often to check the lag. */
    liveEdgeCheckMs: 1000,
  },
  /** How long the tab strip stays up after the last keypress. */
  stripHideDelayMs: 4000,
} as const;
