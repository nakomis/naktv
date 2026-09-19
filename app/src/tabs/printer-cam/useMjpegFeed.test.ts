import { act, renderHook } from '@testing-library/react';
import { type FeedConfig, useMjpegFeed } from './useMjpegFeed';

const config: FeedConfig = {
  streamUrl: 'http://cam/?action=stream',
  snapshotUrl: 'http://cam/?action=snapshot',
  reconnectDelayMs: 2000,
  maxStreamFailures: 3,
  snapshotIntervalMs: 1000,
  streamRetryMs: 60_000,
};

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useMjpegFeed', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    setHidden(false);
  });

  it('starts on the stream with a cache-busted URL', () => {
    const { result } = renderHook(() => useMjpegFeed(config));
    expect(result.current.src).toMatch(/^http:\/\/cam\/\?action=stream&_t=\d+$/);
    expect(result.current.status).toBe('Connecting to printer…');
  });

  it('clears the overlay once a frame loads', () => {
    const { result } = renderHook(() => useMjpegFeed(config));
    act(() => result.current.onLoad());
    expect(result.current.status).toBeNull();
  });

  it('reconnects to the stream after an error', () => {
    const { result } = renderHook(() => useMjpegFeed(config));
    act(() => result.current.onError());
    expect(result.current.status).toBe('Lost connection — retrying…');
    act(() => vi.advanceTimersByTime(config.reconnectDelayMs));
    expect(result.current.src).toContain('action=stream');
    expect(result.current.status).toBe('Connecting to printer…');
  });

  it('falls back to snapshots after repeated failures, then retries the stream', () => {
    const { result } = renderHook(() => useMjpegFeed(config));
    for (let i = 0; i < config.maxStreamFailures; i++) {
      act(() => result.current.onError());
      act(() => vi.advanceTimersByTime(config.reconnectDelayMs));
    }
    expect(result.current.src).toContain('action=snapshot');
    expect(result.current.status).toBe('Stream unstable — polling frames…');

    const first = result.current.src;
    act(() => vi.advanceTimersByTime(config.snapshotIntervalMs + 1));
    expect(result.current.src).not.toBe(first);
    expect(result.current.src).toContain('action=snapshot');

    // An error whilst polling doesn't restart anything; the next tick retries.
    act(() => result.current.onError());
    expect(result.current.src).toContain('action=snapshot');

    act(() => vi.advanceTimersByTime(config.streamRetryMs));
    expect(result.current.src).toContain('action=stream');
  });

  it('resets the failure count when a frame arrives', () => {
    const { result } = renderHook(() => useMjpegFeed(config));
    for (let i = 0; i < config.maxStreamFailures - 1; i++) {
      act(() => result.current.onError());
      act(() => vi.advanceTimersByTime(config.reconnectDelayMs));
    }
    act(() => result.current.onLoad());
    act(() => result.current.onError());
    expect(result.current.status).toBe('Lost connection — retrying…');
  });

  it('drops the connection whilst backgrounded and reconnects on return', () => {
    const { result } = renderHook(() => useMjpegFeed(config));
    act(() => setHidden(true));
    expect(result.current.src).toBeUndefined();
    act(() => setHidden(false));
    expect(result.current.src).toContain('action=stream');
  });

  it('cancels pending timers on unmount', () => {
    const { result, unmount } = renderHook(() => useMjpegFeed(config));
    act(() => result.current.onError());
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
