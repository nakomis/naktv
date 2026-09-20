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

/** Dropped rather than queued without bound if the decoder falls behind. */
const MAX_QUEUED_SEGMENTS = 40;

/** Seconds of already-played buffer to keep before evicting. */
const BUFFER_KEEP_SECONDS = 20;

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
  let stallTimer: ReturnType<typeof setInterval> | undefined;

  const queue: ArrayBuffer[] = [];

  const stopWatchdog = () => {
    if (stallTimer !== undefined) clearInterval(stallTimer);
    stallTimer = undefined;
  };

  const fail = (reason: string) => {
    if (closed) return;
    stopWatchdog();
    handlers.onError?.(reason);
  };

  /** Watches segment arrival, because a silently stopped stream fires nothing. */
  let lastSegmentAt = Date.now();
  const startWatchdog = () => {
    lastSegmentAt = Date.now();
    stallTimer = setInterval(() => {
      if (closed) return;
      if (Date.now() - lastSegmentAt >= STALL_LIMIT_MS) fail('stalled');
    }, STALL_CHECK_MS);
  };

  if (typeof MediaSource === 'undefined') {
    // jsdom, and any browser too old to matter here.
    queueMicrotask(() => fail('MediaSource unavailable'));
    return { close: () => undefined };
  }

  const mediaSource = new MediaSource();
  objectUrl = URL.createObjectURL(mediaSource);
  video.src = objectUrl;

  /** Drop buffered data we have already played, so memory doesn't creep up. */
  const evict = () => {
    if (!sourceBuffer || sourceBuffer.updating) return;
    const buffered = sourceBuffer.buffered;
    if (!buffered.length) return;
    const start = buffered.start(0);
    const cutoff = video.currentTime - BUFFER_KEEP_SECONDS;
    if (cutoff > start) {
      try {
        sourceBuffer.remove(start, cutoff);
      } catch {
        // Removal is best-effort; a failure here is not worth dropping the feed.
      }
    }
  };

  const flush = () => {
    if (closed || !sourceBuffer || sourceBuffer.updating) return;
    const next = queue.shift();
    if (!next) {
      evict();
      return;
    }
    try {
      sourceBuffer.appendBuffer(next);
    } catch (error) {
      fail(`appendBuffer: ${(error as Error).name}`);
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
      if (closed) return;

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
      // Falling behind is better handled by dropping stale segments than by
      // growing without bound; liveEdge.ts then pulls us back to the live edge.
      if (queue.length > MAX_QUEUED_SEGMENTS) {
        queue.splice(0, queue.length - MAX_QUEUED_SEGMENTS / 2);
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
