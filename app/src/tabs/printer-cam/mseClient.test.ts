import { connectMse, mseLog } from './mseClient';

/**
 * The fakes are driven by hand rather than on a timer: every test wants to say
 * "now the socket opened", "now go2rtc replied", and assert in between.
 */
class FakeSourceBuffer extends EventTarget {
  mode = 'segments';
  updating = false;
  appended: ArrayBuffer[] = [];
  removed: Array<[number, number]> = [];
  /** How many upcoming appends to refuse as the TV does when its buffer is full. */
  quotaFailures = 0;
  removeThrows = false;
  buffered = { length: 1, start: () => 0, end: () => 100 } as unknown as TimeRanges;
  appendBuffer(data: ArrayBuffer) {
    if (this.quotaFailures > 0) {
      this.quotaFailures -= 1;
      throw new DOMException('full', 'QuotaExceededError');
    }
    this.appended.push(data);
  }
  remove(start: number, end: number) {
    if (this.removeThrows) throw new DOMException('bad state', 'InvalidStateError');
    this.removed.push([start, end]);
  }
}

class FakeMediaSource extends EventTarget {
  static last: FakeMediaSource | undefined;
  buffers: FakeSourceBuffer[] = [];
  mime: string | undefined;
  throwOnAdd = false;

  constructor() {
    super();
    FakeMediaSource.last = this;
  }
  addSourceBuffer(mime: string) {
    if (this.throwOnAdd) throw new DOMException('bad codec', 'NotSupportedError');
    this.mime = mime;
    const buffer = new FakeSourceBuffer();
    this.buffers.push(buffer);
    return buffer as unknown as SourceBuffer;
  }
  open() {
    this.dispatchEvent(new Event('sourceopen'));
  }
}

class FakeSocket {
  static last: FakeSocket | undefined;
  binaryType = '';
  sent: string[] = [];
  closed = false;
  onopen: ((e: Event) => void) | null = null;
  onclose: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;

  url: string;

  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
}

/** A TimeRanges stand-in, since jsdom's buffered is empty and read-only. */
function ranges(pairs: Array<[number, number]>): TimeRanges {
  return {
    length: pairs.length,
    start: (i: number) => pairs[i][0],
    end: (i: number) => pairs[i][1],
  } as unknown as TimeRanges;
}

function makeVideo(currentTime = 90, buffered: Array<[number, number]> = []): HTMLVideoElement {
  const video = document.createElement('video');
  Object.defineProperty(video, 'currentTime', { value: currentTime, writable: true });
  Object.defineProperty(video, 'buffered', { value: ranges(buffered), writable: true });
  return video;
}

/** Drives a connection up to the point where a SourceBuffer exists. */
function openStream(video: HTMLVideoElement = makeVideo()) {
  const onError = vi.fn();
  const onPlaying = vi.fn();
  const connection = connectMse(video, 'ws://phi:1984/api/ws?src=printer_av', {
    onError,
    onPlaying,
  });
  FakeMediaSource.last?.open();
  FakeSocket.last?.onopen?.(new Event('open'));
  return { video, onError, onPlaying, connection };
}

function reply(mime = 'video/mp4; codecs="avc1.640029,mp4a.40.2"') {
  FakeSocket.last?.onmessage?.(
    new MessageEvent('message', { data: JSON.stringify({ type: 'mse', value: mime }) }),
  );
}

describe('connectMse', () => {
  beforeEach(() => {
    FakeMediaSource.last = undefined;
    FakeSocket.last = undefined;
    vi.stubGlobal('MediaSource', FakeMediaSource);
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:test',
      revokeObjectURL: () => undefined,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens the socket only once the MediaSource is ready', () => {
    const video = makeVideo();
    connectMse(video, 'ws://phi:1984/api/ws?src=printer_av');
    expect(FakeSocket.last).toBeUndefined();

    FakeMediaSource.last?.open();
    expect(FakeSocket.last?.url).toBe('ws://phi:1984/api/ws?src=printer_av');
  });

  it('advertises the codecs go2rtc needs to pick a mux', () => {
    openStream();
    const request = JSON.parse(FakeSocket.last?.sent[0] ?? '{}');
    expect(request.type).toBe('mse');
    // Video and audio both: the point of the stream is that it carries both.
    expect(request.value).toContain('avc1.640029');
    expect(request.value).toContain('mp4a.40.2');
  });

  it('opens a SourceBuffer with the MIME type go2rtc replies with', () => {
    const { onPlaying } = openStream();
    reply();
    expect(FakeMediaSource.last?.mime).toBe('video/mp4; codecs="avc1.640029,mp4a.40.2"');
    expect(onPlaying).toHaveBeenCalled();
  });

  it('appends binary segments to the SourceBuffer', () => {
    openStream();
    reply();
    const segment = new ArrayBuffer(8);
    FakeSocket.last?.onmessage?.(new MessageEvent('message', { data: segment }));
    expect(FakeMediaSource.last?.buffers[0].appended).toContain(segment);
  });

  it('evicts played-out buffer rather than growing without bound', () => {
    openStream();
    reply();
    const buffer = FakeMediaSource.last?.buffers[0];
    // An updateend with nothing queued is the client's cue to trim.
    buffer?.dispatchEvent(new Event('updateend'));
    expect(buffer?.removed.length).toBe(1);
    expect(buffer?.removed[0][0]).toBe(0);
  });

  it('reports an unusable codec so the caller can fall back', () => {
    const { onError } = openStream();
    const source = FakeMediaSource.last;
    if (source) source.throwOnAdd = true;
    reply();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('addSourceBuffer'));
  });

  it('reports a dropped socket so the caller can fall back', () => {
    const { onError } = openStream();
    FakeSocket.last?.onclose?.(new Event('close'));
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('closed'));
  });

  it('goes quiet after close, so a stale stream cannot fire the fallback', () => {
    const { onError, connection } = openStream();
    connection.close();
    expect(FakeSocket.last?.closed).toBe(true);

    FakeSocket.last?.onclose?.(new Event('close'));
    expect(onError).not.toHaveBeenCalled();
  });

  // go2rtc restarting a producer leaves the socket open and simply stops
  // sending, so nothing fires an error and the picture freezes silently.
  it('reports a stall when segments stop arriving', () => {
    vi.useFakeTimers();
    try {
      const { onError } = openStream();
      reply();

      vi.advanceTimersByTime(4000);
      expect(onError).not.toHaveBeenCalled();

      vi.advanceTimersByTime(8000);
      expect(onError).toHaveBeenCalledWith('stalled');
    } finally {
      vi.useRealTimers();
    }
  });

  // currentTime is deliberately NOT the signal: seekToLiveEdge nudges it every
  // second, which would mask exactly the stall we are trying to catch.
  it('does not report a stall while segments keep arriving', () => {
    vi.useFakeTimers();
    try {
      const { onError } = openStream();
      reply();
      for (let tick = 0; tick < 10; tick += 1) {
        FakeSocket.last?.onmessage?.(new MessageEvent('message', { data: new ArrayBuffer(4) }));
        vi.advanceTimersByTime(2000);
      }
      expect(onError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // A feed that comes and goes leaves holes, and MSE will not skip one: the
  // playhead stops at the hole with data buffered beyond it, forever.
  it('jumps the playhead over a gap it is stranded in', () => {
    vi.useFakeTimers();
    try {
      // Stranded at 50: buffered data sits behind it and ahead of it.
      const video = makeVideo(50, [
        [10, 40],
        [60, 90],
      ]);
      const { onError } = openStream(video);
      reply();

      vi.advanceTimersByTime(2500);

      expect(video.currentTime).toBeCloseTo(60.05, 2);
      // Recovering is not a failure; the feed should not be torn down.
      expect(onError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the playhead alone when it is inside a buffered range', () => {
    vi.useFakeTimers();
    try {
      const video = makeVideo(50, [[10, 90]]);
      openStream(video);
      reply();
      vi.advanceTimersByTime(2500);
      expect(video.currentTime).toBe(50);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not jump backwards when every range is behind the playhead', () => {
    vi.useFakeTimers();
    try {
      const video = makeVideo(95, [[10, 90]]);
      openStream(video);
      reply();
      vi.advanceTimersByTime(2500);
      expect(video.currentTime).toBe(95);
    } finally {
      vi.useRealTimers();
    }
  });

  // Dropping queued segments to trim the backlog is what created the gaps in
  // the first place, so falling this far behind reconnects instead.
  it('reports overflow rather than silently dropping segments', () => {
    const { onError } = openStream();
    reply();
    const buffer = FakeMediaSource.last?.buffers[0];
    if (buffer) buffer.updating = true; // nothing can drain whilst appending

    for (let i = 0; i < 200; i += 1) {
      FakeSocket.last?.onmessage?.(new MessageEvent('message', { data: new ArrayBuffer(4) }));
    }
    expect(onError).toHaveBeenCalledWith('queue overflow');
  });

  it('falls back immediately where MediaSource is missing', async () => {
    vi.stubGlobal('MediaSource', undefined);
    const onError = vi.fn();
    connectMse(makeVideo(), 'ws://phi:1984/api/ws?src=printer_av', { onError });
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith('MediaSource unavailable');
  });

  describe('ManagedMediaSource (NAKTV-31)', () => {
    beforeEach(() => {
      // An iPhone: no classic MediaSource, only the managed one.
      vi.stubGlobal('MediaSource', undefined);
      vi.stubGlobal('ManagedMediaSource', FakeMediaSource);
    });

    it('plays through ManagedMediaSource where there is no MediaSource', () => {
      const { onError, onPlaying } = openStream();
      reply();
      expect(FakeSocket.last?.url).toBe('ws://phi:1984/api/ws?src=printer_av');
      expect(onPlaying).toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    });

    it('opts the element out of remote playback, or the source never opens', () => {
      const video = makeVideo();
      connectMse(video, 'ws://phi:1984/api/ws?src=printer_av');
      expect((video as { disableRemotePlayback?: boolean }).disableRemotePlayback).toBe(true);
    });

    it('logs the system asking it to stop streaming', () => {
      openStream();
      FakeMediaSource.last?.dispatchEvent(new Event('endstreaming'));
      expect(mseLog[mseLog.length - 1]?.event).toBe('managed: endstreaming');
    });

    it('prefers the classic MediaSource where both exist', () => {
      class OtherSource extends FakeMediaSource {}
      vi.stubGlobal('MediaSource', OtherSource);
      const video = makeVideo();
      connectMse(video, 'ws://phi:1984/api/ws?src=printer_av');
      expect(FakeMediaSource.last).toBeInstanceOf(OtherSource);
      expect((video as { disableRemotePlayback?: boolean }).disableRemotePlayback).toBeFalsy();
    });
  });

  describe('buffer management (NAKTV-27)', () => {
    function segment() {
      FakeSocket.last?.onmessage?.(new MessageEvent('message', { data: new ArrayBuffer(4) }));
    }

    beforeEach(() => {
      mseLog.length = 0;
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    // Segments arrive back to back, so the queue can go minutes without being
    // empty at an updateend. On the TV that let the buffer reach 74 s.
    it('trims on a timer even when the queue never empties', () => {
      vi.useFakeTimers();
      try {
        openStream(makeVideo(90));
        reply();
        const buffer = FakeMediaSource.last?.buffers[0];
        segment();
        expect(buffer?.removed).toEqual([]);

        vi.advanceTimersByTime(2000);
        expect(buffer?.removed).toEqual([[0, 70]]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('trims hard and retries the same segment when the buffer is full', () => {
      const { onError } = openStream(makeVideo(90));
      reply();
      const buffer = FakeMediaSource.last?.buffers[0];
      if (!buffer) throw new Error('no buffer');
      buffer.quotaFailures = 1;

      const refused = new ArrayBuffer(8);
      FakeSocket.last?.onmessage?.(new MessageEvent('message', { data: refused }));
      // Trimmed to a second behind the playhead, and nothing appended yet.
      expect(buffer.removed).toEqual([[0, 89]]);
      expect(buffer.appended).toEqual([]);

      // The removal finishing is what retries it: same segment, not dropped.
      buffer.dispatchEvent(new Event('updateend'));
      expect(buffer.appended).toEqual([refused]);
      expect(onError).not.toHaveBeenCalled();
      expect(mseLog.map((e) => e.event)).toEqual([
        'buffer full: trimmed to retry the append',
        'recovered: append succeeded after trimming',
      ]);
    });

    it('gives up if the retry is refused as well', () => {
      const { onError } = openStream(makeVideo(90));
      reply();
      const buffer = FakeMediaSource.last?.buffers[0];
      if (!buffer) throw new Error('no buffer');
      buffer.quotaFailures = 2;

      segment();
      buffer.dispatchEvent(new Event('updateend'));
      expect(onError).toHaveBeenCalledWith('appendBuffer: QuotaExceededError');
    });

    it('gives up at once if there is nothing played to trim', () => {
      // Playhead at the very start: everything buffered is still ahead of it.
      const { onError } = openStream(makeVideo(0.5));
      reply();
      const buffer = FakeMediaSource.last?.buffers[0];
      if (buffer) buffer.quotaFailures = 1;
      segment();
      expect(onError).toHaveBeenCalledWith('appendBuffer: QuotaExceededError');
    });

    it('records every failure with its reason', () => {
      const { onError } = openStream();
      FakeSocket.last?.onclose?.(new Event('close'));
      expect(onError).toHaveBeenCalled();
      expect(mseLog[mseLog.length - 1]?.event).toBe('failed: websocket closed');
      expect(console.warn).toHaveBeenCalledWith('[naktv/mse] failed: websocket closed');
    });

    it('records a removal that fails instead of swallowing it', () => {
      openStream(makeVideo(90));
      reply();
      const buffer = FakeMediaSource.last?.buffers[0];
      if (!buffer) throw new Error('no buffer');
      buffer.removeThrows = true;
      buffer.dispatchEvent(new Event('updateend'));
      expect(mseLog[mseLog.length - 1]?.event).toBe('remove failed: InvalidStateError');
    });

    it('reports a failure once, however many segments follow it', () => {
      const { onError } = openStream();
      reply();
      const buffer = FakeMediaSource.last?.buffers[0];
      if (buffer) buffer.updating = true;
      for (let i = 0; i < 200; i += 1) segment();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(mseLog.filter((e) => e.event.startsWith('failed'))).toHaveLength(1);
    });

    it('appends everything queued during an append in one go', () => {
      openStream();
      reply();
      const buffer = FakeMediaSource.last?.buffers[0];
      if (!buffer) throw new Error('no buffer');
      buffer.updating = true;
      const parts = [new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5, 6])];
      for (const part of parts) {
        FakeSocket.last?.onmessage?.(new MessageEvent('message', { data: part.buffer }));
      }
      expect(buffer.appended).toHaveLength(0);

      buffer.updating = false;
      buffer.dispatchEvent(new Event('updateend'));
      expect(buffer.appended).toHaveLength(1);
      expect([...new Uint8Array(buffer.appended[0])]).toEqual([1, 2, 3, 4, 5, 6]);
    });
  });
});
