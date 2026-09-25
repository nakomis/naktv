import { act, renderHook, waitFor } from '@testing-library/react';
import { useNowPlaying } from './useNowPlaying';

const PLAYING = {
  track: 'Time',
  album: 'Inception (Music from the Motion Picture)',
  artists: ['Hans Zimmer'],
  uri: 'spotify:track:abc',
  playing: true,
  updatedAt: '2026-09-24T12:00:00Z',
};

function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 502, json: () => Promise.resolve(body) });
}

describe('useNowPlaying', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('polls the feed and shapes the result', async () => {
    const fetchMock = vi.fn((_url: string) => jsonResponse(PLAYING));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useNowPlaying(true));
    await waitFor(() => expect(result.current).toEqual({ track: 'Time', album: 'Inception' }));

    const asked = fetchMock.mock.calls.map(([u]) => String(u));
    expect(asked.every((u) => u.endsWith('/now-playing.json'))).toBe(true);
  });

  it('shows nothing when the feed reports paused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse({ ...PLAYING, playing: false })),
    );
    const { result } = renderHook(() => useNowPlaying(true));
    await act(async () => {});
    expect(result.current).toBeNull();
  });

  it('shows nothing when the feed cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const { result } = renderHook(() => useNowPlaying(true));
    await act(async () => {});
    expect(result.current).toBeNull();
  });

  it('shows nothing when the feed errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse({}, false)),
    );
    const { result } = renderHook(() => useNowPlaying(true));
    await act(async () => {});
    expect(result.current).toBeNull();
  });

  it('does not poll at all when the overlay is off', async () => {
    const fetchMock = vi.fn(() => jsonResponse(PLAYING));
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useNowPlaying(false));
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops polling when unmounted', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => jsonResponse(PLAYING));
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = renderHook(() => useNowPlaying(true));
    await act(async () => {});
    const afterFirst = fetchMock.mock.calls.length;

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(fetchMock.mock.calls.length).toBe(afterFirst);
  });

  it('does not start a new poll while one is still in flight', async () => {
    vi.useFakeTimers();
    let resolveFetch: ((value: unknown) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useNowPlaying(true));
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch?.({ ok: true, status: 200, json: () => Promise.resolve(PLAYING) });
    });
  });
});
