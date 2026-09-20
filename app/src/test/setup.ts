import '@testing-library/jest-dom/vitest';

// jsdom implements neither MediaSource nor object URLs, and the printer cam
// now plays through MSE (see mseClient.ts). Without these the client reports
// "MediaSource unavailable" and every test drops straight to the MJPEG
// fallback, which is not what any of them is trying to exercise.
//
// These stand-ins do just enough: open a source, hand back a SourceBuffer and
// swallow appends. Nothing decodes, so tests assert on wiring, not playback.

class FakeSourceBuffer extends EventTarget {
  mode = 'segments';
  updating = false;
  buffered = { length: 0, start: () => 0, end: () => 0 } as unknown as TimeRanges;
  appendBuffer() {}
  remove() {}
}

class FakeMediaSource extends EventTarget {
  readyState = 'closed';
  addSourceBuffer() {
    return new FakeSourceBuffer() as unknown as SourceBuffer;
  }
  endOfStream() {}
  constructor() {
    super();
    // Real MediaSource fires this once the element attaches the object URL.
    queueMicrotask(() => {
      this.readyState = 'open';
      this.dispatchEvent(new Event('sourceopen'));
    });
  }
}

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  binaryType = 'arraybuffer';
  readyState = FakeWebSocket.OPEN;
  onopen: ((e: Event) => void) | null = null;
  onclose: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  send() {}
  close() {}
}

if (typeof globalThis.MediaSource === 'undefined') {
  globalThis.MediaSource = FakeMediaSource as unknown as typeof MediaSource;
}
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
}
// jsdom *does* provide createObjectURL, but it throws on anything that is not
// a Blob — including our fake MediaSource — so it is replaced outright.
URL.createObjectURL = () => 'blob:naktv-test';
URL.revokeObjectURL = () => undefined;
