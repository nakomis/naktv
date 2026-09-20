// Every deployment-specific value lives here.
//
// The feed is mjpg-streamer inside the OctoPrint container on Leia, exposed
// LAN-only on host port 8090 (8080 is scrutiny's). The *.home.nakomis.com
// vhosts demand an mTLS client certificate, which a sideloaded webOS app
// cannot present, so the app goes direct.
//
// Leia's IP rather than leia.local: webOS doesn't reliably resolve mDNS names.
const LEIA = 'http://172.29.0.32:8090';

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
  },
  /** How long the tab strip stays up after the last keypress. */
  stripHideDelayMs: 4000,
} as const;
