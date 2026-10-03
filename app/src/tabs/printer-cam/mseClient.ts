// Plays a go2rtc stream through Media Source Extensions.
//
// The camera stream carries a Spotify audio track as well as video (see
// feed/README.md for why the audio has to be muxed in rather than played
// alongside). Of the transports go2rtc offers, MSE is the only one this TV
// will take both tracks from:
//
//   - progressive stream.mp4 plays the audio and never renders the video
//   - stream.m3u8 is refused outright with NotSupportedError
//   - MSE accepts one SourceBuffer of "avc1.640029,mp4a.40.2" and plays both
//
// The protocol is go2rtc's: connect to /api/ws?src=NAME, send a "mse" message
// listing the codecs we support, receive the MIME type to open a SourceBuffer
// with, then append every binary frame that follows.

/** Codecs we advertise to go2rtc. High profile first — it is what phi encodes. */
const CODECS = 'avc1.640029,avc1.42E01E,mp4a.40.2';

/**
 * Concatenates queued segments, so one append carries everything that arrived
 * while the last one was in progress (NAKTV-27).
 *
 * Appending them one at a time made the TV's per-append overhead - each one a
 * round trip through "updating" and updateend - the bottleneck: segments
 * arrived faster than that, the queue grew until it overflowed, and the feed
 * fell back. go2rtc's own player batches its appends for the same reason.
 */
function concatSegments(segments: ArrayBuffer[]): ArrayBuffer {
  if (segments.length === 1) return segments[0];
  let total = 0;
  for (const segment of segments) total += segment.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const segment of segments) {
    out.set(new Uint8Array(segment), offset);
    offset += segment.byteLength;
  }
  return out.buffer;
}

/**
 * A queue this deep means we are not keeping up at all.
 *
 * Segments are never dropped to trim it: dropping one that has not been
 * appended punches a hole in the buffer, and MSE does not skip holes — the
 * playhead reaches it and stalls there indefinitely, with data buffered on
 * the far side it will never reach. That is worth a reconnect instead, which
 * starts cleanly at the live edge. Latency is the live-edge chase's job
 * (liveEdge.ts), not this one's.
 */
const MAX_QUEUED_SEGMENTS = 120;

/** Seconds of already-played buffer to keep before evicting. */
const BUFFER_KEEP_SECONDS = 20;

/**
 * How much played buffer to keep when the TV refuses an append for lack of
 * room (QuotaExceededError): just enough that the playhead is not left at the
 * very edge of what remains.
 */
const QUOTA_KEEP_SECONDS = 1;

/** How many recent events `mseLog` keeps. */
const LOG_LIMIT = 50;

export interface MseLogEntry {
  at: string;
  event: string;
}

/**
 * Recent failures and recoveries, newest last (NAKTV-27).
 *
 * Every failure used to go to onError and nowhere else, so when the sound died
 * there was no record of why. Also reachable as `window.__naktvMseLog`, for
 * reading over ares-inspect without a rebuild.
 */
export const mseLog: MseLogEntry[] = [];

function log(event: string): void {
  mseLog.push({ at: new Date().toISOString(), event });
  if (mseLog.length > LOG_LIMIT) mseLog.shift();
  console.warn(`[naktv/mse] ${event}`);
}

if (typeof window !== 'undefined') {
  (window as unknown as { __naktvMseLog: MseLogEntry[] }).__naktvMseLog = mseLog;
}

/** How often to check that playback is still progressing. */
const STALL_CHECK_MS = 2000;

/**
 * How long the socket may go without delivering a segment before we call the
 * stream dead.
 *
 * A producer restart on the go2rtc side leaves the socket open and simply
 * stops sending, so nothing fires an error and the picture freezes silently
 * until someone relaunches the app.
 *
 * Deliberately measured on segment arrival rather than on currentTime:
 * seekToLiveEdge nudges currentTime once a second, which resets a
 * progress-based clock and hides the very stall we are looking for. Arrival is
 * also the thing that actually stops, so it is the honest signal.
 */
const STALL_LIMIT_MS = 8000;

/**
 * The MediaSource to play through, and whether it is the managed kind.
 *
 * The TVs have the classic MediaSource. iPhone WebKit doesn't, and never has:
 * since iOS 17.1 it offers ManagedMediaSource instead, which takes the same
 * SourceBuffer calls but lets the system decide when to buffer and evict
 * (NAKTV-31). iPad and macOS have both, and get the classic one.
 */
function mediaSourceConstructor():
  | { Constructor: typeof MediaSource; managed: boolean }
  | undefined {
  const scope = globalThis as {
    MediaSource?: typeof MediaSource;
    ManagedMediaSource?: typeof MediaSource;
  };
  if (scope.MediaSource) return { Constructor: scope.MediaSource, managed: false };
  if (scope.ManagedMediaSource) return { Constructor: scope.ManagedMediaSource, managed: true };
  return undefined;
}

export interface MseHandlers {
  /** Fired once media is actually flowing. */
  onPlaying?: () => void;
  /** Fired on any failure; the caller falls back to MJPEG. */
  onError?: (reason: string) => void;
}

export interface MseConnection {
  close: () => void;
}

/**
 * Attaches `url` to `video` over MSE. Returns a handle whose `close` tears
 * everything down — call it before attaching another, or stale socket
 * handlers keep appending to a detached SourceBuffer.
 */
export function connectMse(
  video: HTMLVideoElement,
  url: string,
  handlers: MseHandlers = {},
): MseConnection {
  let socket: WebSocket | undefined;
  let sourceBuffer: SourceBuffer | undefined;
  let objectUrl: string | undefined;
  let closed = false;
  /** Set by the first failure: everything after it on this connection is ignored. */
  let failed = false;
  let stallTimer: ReturnType<typeof setInterval> | undefined;

  const queue: ArrayBuffer[] = [];

  const stopWatchdog = () => {
    if (stallTimer !== undefined) clearInterval(stallTimer);
    stallTimer = undefined;
  };

  /**
   * Reports a failure, once. Segments keep arriving until the caller tears the
   * connection down, and each one used to fail again: 50 onError calls in a
   * second used up useVideoFeed's quick retries at once and left the silent
   * MJPEG fallback up for two minutes (NAKTV-27).
   */
  const fail = (reason: string) => {
    if (closed || failed) return;
    failed = true;
    stopWatchdog();
    log(`failed: ${reason}`);
    handlers.onError?.(reason);
  };

  /**
   * Jump the playhead forward when it is stranded outside every buffered
   * range.
   *
   * A feed that comes and goes — phi asleep, a flaky link — leaves holes in
   * the buffer, and MSE will not skip one: playback stops at the hole with
   * data buffered beyond it that it will never reach, and stays there until
   * the app is relaunched by hand.
   *
   * Being outside every range is unambiguous: playback cannot proceed from
   * there under any circumstances, so moving to the next range is always
   * right. That makes this safe to check on a timer without tracking progress
   * — which matters, because currentTime is nudged by the live-edge chase and
   * is not a trustworthy progress signal on this TV.
   */
  const skipGapIfStranded = (): boolean => {
    const ranges = video.buffered;
    if (!ranges.length) return false;

    for (let i = 0; i < ranges.length; i += 1) {
      if (video.currentTime >= ranges.start(i) && video.currentTime < ranges.end(i)) {
        return false;
      }
    }

    for (let i = 0; i < ranges.length; i += 1) {
      if (ranges.start(i) > video.currentTime) {
        // A shade past the boundary: landing exactly on it can strand us again.
        video.currentTime = ranges.start(i) + 0.05;
        return true;
      }
    }
    return false;
  };

  /** Watches segment arrival, because a silently stopped stream fires nothing. */
  let lastSegmentAt = Date.now();
  const startWatchdog = () => {
    lastSegmentAt = Date.now();
    stallTimer = setInterval(() => {
      if (closed) return;
      // On the timer as well as between appends: segments arrive back to
      // back, so the queue can go minutes without being empty at an
      // updateend, and the buffer grew unchecked until the TV refused an
      // append (NAKTV-27).
      evict();
      if (skipGapIfStranded()) return;
      if (Date.now() - lastSegmentAt >= STALL_LIMIT_MS) fail('stalled');
    }, STALL_CHECK_MS);
  };

  const source = mediaSourceConstructor();
  if (!source) {
    // jsdom, an iPhone before iOS 17.1, and any browser too old to matter here.
    queueMicrotask(() => fail('MediaSource unavailable'));
    return { close: () => undefined };
  }

  if (source.managed) {
    // A ManagedMediaSource never opens on an element that could be handed to
    // AirPlay, unless an AirPlay-able alternative source is offered too. There
    // is none for a live go2rtc socket, so opt out of remote playback.
    (video as { disableRemotePlayback?: boolean }).disableRemotePlayback = true;
  }

  const mediaSource = new source.Constructor();
  if (source.managed) {
    // The system's hints about when it wants data. A live feed can't pause
    // for them, so they are only logged: if the picture dies on an iPhone,
    // this says whether WebKit asked us to stop first.
    mediaSource.addEventListener('startstreaming', () => log('managed: startstreaming'));
    mediaSource.addEventListener('endstreaming', () => log('managed: endstreaming'));
  }
  objectUrl = URL.createObjectURL(mediaSource);
  video.src = objectUrl;

  /**
   * Drop buffered data older than `keepSeconds` behind the playhead, so memory
   * doesn't creep up. Returns whether a removal was started.
   */
  const evict = (keepSeconds: number = BUFFER_KEEP_SECONDS): boolean => {
    if (!sourceBuffer || sourceBuffer.updating) return false;
    const buffered = sourceBuffer.buffered;
    if (!buffered.length) return false;
    const start = buffered.start(0);
    const cutoff = video.currentTime - keepSeconds;
    if (cutoff <= start) return false;
    try {
      sourceBuffer.remove(start, cutoff);
      return true;
    } catch (error) {
      // Not worth dropping the feed over, but no longer silent: a removal
      // that keeps failing is how the buffer fills.
      log(`remove failed: ${(error as Error).name}`);
      return false;
    }
  };

  /** Set while an append refused for lack of room waits to be retried. */
  let retryingAfterQuota = false;

  const flush = () => {
    if (closed || failed || !sourceBuffer || sourceBuffer.updating) return;
    if (!queue.length) {
      evict();
      return;
    }
    const next = concatSegments(queue.splice(0));
    try {
      sourceBuffer.appendBuffer(next);
      if (retryingAfterQuota) log('recovered: append succeeded after trimming');
      retryingAfterQuota = false;
    } catch (error) {
      const name = (error as Error).name;
      // The TV's buffer is full. Trim hard and retry the same segment once the
      // removal completes (its updateend calls flush again). Dropping it would
      // punch a hole the playhead can't cross. Fail only if trimming frees
      // nothing, or if the retry is refused too.
      if (name === 'QuotaExceededError' && !retryingAfterQuota) {
        queue.unshift(next);
        retryingAfterQuota = true;
        if (evict(QUOTA_KEEP_SECONDS)) {
          log('buffer full: trimmed to retry the append');
          return;
        }
      }
      fail(`appendBuffer: ${name}`);
    }
  };

  mediaSource.addEventListener('sourceopen', () => {
    if (closed) return;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      fail(`websocket: ${(error as Error).message}`);
      return;
    }
    socket.binaryType = 'arraybuffer';

    socket.onopen = () => socket?.send(JSON.stringify({ type: 'mse', value: CODECS }));
    socket.onerror = () => fail('websocket error');
    socket.onclose = () => fail('websocket closed');

    socket.onmessage = (event: MessageEvent) => {
      if (closed || failed) return;

      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data) as { type: string; value: string };
        if (message.type !== 'mse') return;
        try {
          sourceBuffer = mediaSource.addSourceBuffer(message.value);
          sourceBuffer.mode = 'segments';
          sourceBuffer.addEventListener('updateend', flush);
          startWatchdog();
          handlers.onPlaying?.();
        } catch (error) {
          fail(`addSourceBuffer: ${(error as Error).name}`);
        }
        return;
      }

      lastSegmentAt = Date.now();
      queue.push(event.data as ArrayBuffer);
      if (queue.length > MAX_QUEUED_SEGMENTS) {
        fail('queue overflow');
        return;
      }
      flush();
    };
  });

  return {
    close: () => {
      closed = true;
      stopWatchdog();
      try {
        socket?.close();
      } catch {
        // Already gone.
      }
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      sourceBuffer = undefined;
      queue.length = 0;
    },
  };
}
