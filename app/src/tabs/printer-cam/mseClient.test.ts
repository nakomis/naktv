import { connectMse } from './mseClient';

/**
 * The fakes are driven by hand rather than on a timer: every test wants to say
 * "now the socket opened", "now go2rtc replied", and assert in between.
 */
class FakeSourceBuffer extends EventTarget {
  mode = 'segments';
  updating = false;
  appended: ArrayBuffer[] = [];
  removed: Array<[number, number]> = [];
  buffered = { length: 1, start: () => 0, end: () => 100 } as unknown as TimeRanges;
  appendBuffer(data: ArrayBuffer) {
    this.appended.push(data);
  }
  remove(start: number, end: number) {
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

function makeVideo(): HTMLVideoElement {
  const video = document.createElement('video');
  Object.defineProperty(video, 'currentTime', { value: 90, writable: true });
  return video;
}

/** Drives a connection up to the point where a SourceBuffer exists. */
function openStream() {
  const video = makeVideo();
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

  it('falls back immediately where MediaSource is missing', async () => {
    vi.stubGlobal('MediaSource', undefined);
    const onError = vi.fn();
    connectMse(makeVideo(), 'ws://phi:1984/api/ws?src=printer_av', { onError });
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith('MediaSource unavailable');
  });
});
