import { act, renderHook, waitFor } from '@testing-library/react';
import { useCthulhu } from './useCthulhu';

const PRINTING = {
  print: {
    status: 3,
    statusLabel: 'Exposing',
    filename: 'cthulhu.goo',
    currentLayer: 2,
    totalLayer: 2143,
    progressPercent: 5,
    remainingMs: 60_000,
    totalMs: 120_000,
    errorMessage: null,
  },
};

function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 502, json: () => Promise.resolve(body) });
}

describe('useCthulhu', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('polls the single status endpoint and shapes the result', async () => {
    const fetchMock = vi.fn((_url: string) => jsonResponse(PRINTING));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useCthulhu(true));
    await waitFor(() => expect(result.current.state).toBe('printing'));

    expect(result.current.filename).toBe('cthulhu.goo');
    const asked = fetchMock.mock.calls.map(([u]) => String(u));
    expect(asked.every((u) => u.endsWith('/api/status'))).toBe(true);
  });

  it('reports unavailable when cthulhu errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse({}, false)),
    );
    const { result } = renderHook(() => useCthulhu(true));
    await waitFor(() => expect(result.current.state).toBe('unavailable'));
  });

  // What happens today, before cthulhu sends CORS headers: the browser fails
  // the fetch outright rather than returning a response at all.
  it('reports unavailable when the request throws, as a blocked CORS fetch does', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const { result } = renderHook(() => useCthulhu(true));
    await waitFor(() => expect(result.current.state).toBe('unavailable'));
  });

  it('does not poll at all when the overlay is off', async () => {
    const fetchMock = vi.fn(() => jsonResponse(PRINTING));
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useCthulhu(false));
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops polling when unmounted', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => jsonResponse(PRINTING));
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = renderHook(() => useCthulhu(true));
    await act(async () => {});
    const afterFirst = fetchMock.mock.calls.length;

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(fetchMock.mock.calls.length).toBe(afterFirst);
  });

  // A poll that hasn't resolved yet must not be joined by a second one — the
  // hook is documented to guard against overlapping polls.
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

    renderHook(() => useCthulhu(true));
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The interval fires again whilst the first fetch is still pending.
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch?.({ ok: true, status: 200, json: () => Promise.resolve(PRINTING) });
    });
  });
});
