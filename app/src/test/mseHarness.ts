/**
 * The MediaSource and WebSocket fakes behind mseClient's tests, shared with
 * the components that drive it (NAKTV-8).
 *
 * The fakes are driven by hand rather than on a timer: every test wants to say
 * "now the socket opened", "now go2rtc replied", and assert in between. That
 * is what sets them apart from the self-opening stand-ins in setup.ts.
 */
export class FakeSourceBuffer extends EventTarget {
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

export class FakeMediaSource extends EventTarget {
  static last: FakeMediaSource | undefined;
  /** How many have been made since the test reset this. */
  static created = 0;
  buffers: FakeSourceBuffer[] = [];
  mime: string | undefined;
  throwOnAdd = false;

  constructor() {
    super();
    FakeMediaSource.last = this;
    FakeMediaSource.created += 1;
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

export class FakeSocket {
  static last: FakeSocket | undefined;
  /** Every socket opened since the test reset this. */
  static all: FakeSocket[] = [];
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
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
}

/** A TimeRanges stand-in, since jsdom's buffered is empty and read-only. */
export function ranges(pairs: Array<[number, number]>): TimeRanges {
  return {
    length: pairs.length,
    start: (i: number) => pairs[i][0],
    end: (i: number) => pairs[i][1],
  } as unknown as TimeRanges;
}

export function makeVideo(
  currentTime = 90,
  buffered: Array<[number, number]> = [],
): HTMLVideoElement {
  const video = document.createElement('video');
  Object.defineProperty(video, 'currentTime', { value: currentTime, writable: true });
  Object.defineProperty(video, 'buffered', { value: ranges(buffered), writable: true });
  return video;
}

/** Hands go2rtc's MIME reply to the latest socket. */
export function reply(mime = 'video/mp4; codecs="avc1.640029,mp4a.40.2"') {
  FakeSocket.last?.onmessage?.(
    new MessageEvent('message', { data: JSON.stringify({ type: 'mse', value: mime }) }),
  );
}
