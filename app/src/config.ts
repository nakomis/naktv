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
import secrets from './secrets.json';
import { getSettings } from './settings';

const LEIA = 'http://172.29.0.32:8090';
// cthulhu's camera service on phi — the Elegoo Mars 5 Ultra's MJPEG fallback.
// Fixed like LEIA above rather than following the go2rtcHost setting: it's a
// separate always-on service, not go2rtc itself.
const CTHULHU_CAMERA = 'http://172.29.0.14:9121';
const GO2RTC_PORT = 1984;
/**
 * Static file server for `now-playing.json`, run alongside librespot by
 * `feed/bin/spotify-connect.sh` on the same box as go2rtc. Free on phi.
 */
const NOW_PLAYING_PORT = 1985;

/**
 * go2rtc URLs for `stream` on the currently configured host (Settings tab).
 *
 * Both camera tabs use an `_av` stream: video with a Spotify audio track
 * muxed in, so the TV plays both from a single media element. That is not a
 * convenience: webOS allows an app exactly one media element, and a <video>
 * and a separate <audio> force-pause each other — a platform rule, not a DRM
 * one. See feed/README.md. The video-only streams (`printer`, `resin`) are
 * still served, for anything that doesn't want sound.
 */
export function go2rtcUrls(stream: string, host: string = getSettings().go2rtcHost) {
  const base = `http://${host}:${GO2RTC_PORT}`;
  return {
    /**
     * go2rtc's MSE WebSocket. The only transport this TV will play both the
     * video and the muxed Spotify audio from: progressive fMP4 renders no
     * picture once an audio track is present, and HLS is refused outright.
     */
    mseUrl: `ws://${host}:${GO2RTC_PORT}/api/ws?src=${stream}`,
    /** Progressive fMP4. Video-only; kept for the stream without audio. */
    mp4Url: `${base}/api/stream.mp4?src=${stream}`,
    /** Single frame, for the connection check before we commit to the video. */
    frameUrl: `${base}/api/frame.jpeg?src=${stream}`,
  };
}

/**
 * URL for phi's `now-playing.json`, on the currently configured go2rtc host
 * (Settings tab) — it's the same box, not a separately configured one.
 */
export function nowPlayingUrl(host: string = getSettings().go2rtcHost): string {
  return `http://${host}:${NOW_PLAYING_PORT}/now-playing.json`;
}

/**
 * Tuning shared by every camera tab's H.264 player: how long to wait for it,
 * and how it chases the live edge. None of this is camera-specific, only the
 * stream name and the MJPEG fallback are — see `printerCam` and `elegooCam`.
 */
const VIDEO_TUNING = {
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
} as const;

export const CONFIG = {
  printerCam: {
    streamName: 'printer_av',
    streamUrl: `${LEIA}/?action=stream`,
    snapshotUrl: `${LEIA}/?action=snapshot`,
    reconnectDelayMs: 2000,
    /** Consecutive stream failures before dropping to snapshot polling. */
    maxStreamFailures: 5,
    snapshotIntervalMs: 1000,
    /** How long to poll snapshots before trying the proper stream again. */
    streamRetryMs: 5 * 60 * 1000,
    ...VIDEO_TUNING,
  },
  /**
   * The Elegoo Mars 5 Ultra (NAKTV-13), via cthulhu's camera service on phi
   * rather than go2rtc's own printer-facing endpoint — see feed/go2rtc.yaml's
   * `resin`/`resin_av` streams for why.
   */
  elegooCam: {
    streamName: 'resin_av',
    streamUrl: `${CTHULHU_CAMERA}/video`,
    // No snapshot endpoint is guaranteed on cthulhu's camera service, unlike
    // Leia's mjpg-streamer. Left unset: useMjpegFeed falls back to re-fetching
    // the stream URL itself when it needs to degrade further.
    reconnectDelayMs: 2000,
    maxStreamFailures: 5,
    snapshotIntervalMs: 1000,
    streamRetryMs: 5 * 60 * 1000,
    ...VIDEO_TUNING,
  },
  /**
   * OctoPrint, for the print overlay.
   *
   * By vhost name, not by IP: the certificate is issued for the name, so
   * `https://172.29.0.32` fails hostname verification and the TV refuses it.
   * Contrary to the note above about mTLS, this endpoint needs no client
   * certificate — OctoPrint answers an `X-Api-Key` directly, and CORS from the
   * app's origin is permitted. Verified on the B3.
   *
   * The key is populated into `secrets.json` by `scripts/set-config.sh` from
   * SSM `/octoprint/api-key`, the same parameter Ansible templates into
   * OctoPrint itself. A build without AWS credentials keeps the placeholder,
   * and the overlay reports itself unconfigured rather than failing obscurely.
   */
  octoPrint: {
    baseUrl: 'https://octoprint.home.nakomis.com',
    apiKey: secrets.octoprintApiKey,
    /** Temperatures move slowly; this is frequent enough to feel live. */
    pollIntervalMs: 5000,
    /** Give up on a poll well inside the interval, so they cannot pile up. */
    timeoutMs: 4000,
  },
  /**
   * cthulhu, for the Elegoo overlay.
   *
   * By IP, not a vhost name — same reasoning as go2rtcHost above, and cthulhu
   * carries no client certificate requirement either. No API key: cthulhu is
   * LAN-only with nothing to authenticate.
   *
   * IMPORTANT: cthulhu does not send CORS headers yet (fixed separately, to be
   * deployed once the current print finishes), so until then every fetch from
   * the TV's file:// origin fails and useCthulhu reports 'unavailable'. The
   * overlay already treats that as "hide quietly", not as an error.
   */
  cthulhu: {
    baseUrl: 'http://172.29.0.14:9120',
    /** Layer counts and progress move slowly; this is frequent enough to feel live. */
    pollIntervalMs: 5000,
    /** Give up on a poll well inside the interval, so they cannot pile up. */
    timeoutMs: 4000,
  },
  /**
   * Spotify's now-playing feed, written by `feed/bin/now-playing.py` (a
   * librespot `--onevent` hook) and served statically from phi by a tiny HTTP
   * server `spotify-connect.sh` starts alongside librespot. The URL follows
   * `go2rtcHost` (see `nowPlayingUrl` above) rather than living here, since
   * it's the same box, not a separately configured one.
   */
  nowPlaying: {
    /** The now-playing feed changes on track events; this just catches up. */
    pollIntervalMs: 5000,
    /** Give up on a poll well inside the interval, so they cannot pile up. */
    timeoutMs: 4000,
  },
  /** How long the tab strip stays up after the last keypress. */
  stripHideDelayMs: 4000,
} as const;

/** The placeholder `secrets.json.template` ships with. */
export function hasOctoPrintKey(): boolean {
  const key = CONFIG.octoPrint.apiKey;
  return Boolean(key) && !key.startsWith('<');
}
