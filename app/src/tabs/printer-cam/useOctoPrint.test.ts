import { act, renderHook, waitFor } from '@testing-library/react';
import { CONFIG } from '../../config';
import { toStatus, useOctoPrint } from './useOctoPrint';

// Trimmed from what Leia actually returned mid-print, so the shapes are real
// rather than what the docs imply.
const PRINTING = {
  job: { file: { name: 'hanger_1h46m_0.20mm_200C_PLA_CR6SE.gcode' } },
  progress: { printTime: 6034, printTimeLeft: 655 },
  state: 'Printing',
};
const IDLE = {
  job: { file: { name: null } },
  progress: { printTime: null, printTimeLeft: null },
  state: 'Operational',
};
const TEMPS = {
  temperature: {
    tool0: { actual: 199.97, target: 200.0 },
    bed: { actual: 60.03, target: 60.0 },
  },
};

describe('toStatus', () => {
  it('reads a print in progress', () => {
    const s = toStatus(PRINTING, TEMPS);
    expect(s.state).toBe('printing');
    expect(s.name).toBe('hanger');
    expect(s.printTime).toBe('01:40');
    expect(s.remaining).toBe('00:10');
    expect(s.tool).toEqual({ actual: '200.0°C', target: '200.0°C' });
    expect(s.bed).toEqual({ actual: '60.0°C', target: '60.0°C' });
  });

  // Temperatures matter whilst preheating, so they survive an idle printer
  // where the job fields have nothing to say.
  it('keeps temperatures but drops job fields when idle', () => {
    const s = toStatus(IDLE, TEMPS);
    expect(s.state).toBe('idle');
    expect(s.name).toBe('');
    expect(s.printTime).toBe('--:--');
    expect(s.remaining).toBe('--:--');
    expect(s.tool.actual).toBe('200.0°C');
  });

  it('survives a payload with nothing in it', () => {
    const s = toStatus({}, {});
    expect(s.state).toBe('idle');
    expect(s.tool.actual).toBe('--');
  });
});

describe('useOctoPrint', () => {
  const jsonFor = (url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(url.includes('/api/job') ? PRINTING : TEMPS),
    });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('polls both endpoints and shapes the result', async () => {
    const fetchMock = vi.fn((url: string) => jsonFor(url));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useOctoPrint(true));
    await waitFor(() => expect(result.current.state).toBe('printing'));

    expect(result.current.name).toBe('hanger');
    const asked = fetchMock.mock.calls.map(([u]) => String(u));
    expect(asked.some((u) => u.endsWith('/api/job'))).toBe(true);
    expect(asked.some((u) => u.endsWith('/api/printer'))).toBe(true);
  });

  it('sends the API key', async () => {
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => jsonFor(url));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useOctoPrint(true));
    await waitFor(() => expect(result.current.state).toBe('printing'));

    const [, init] = fetchMock.mock.calls[0];
    if (!init) throw new Error('fetch was called without a request init');
    expect((init.headers as Record<string, string>)['X-Api-Key']).toBe(CONFIG.octoPrint.apiKey);
  });

  // Freezing on values that have stopped being true would be worse than
  // admitting we cannot reach it.
  it('reports unavailable when OctoPrint errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) })),
    );
    const { result } = renderHook(() => useOctoPrint(true));
    await waitFor(() => expect(result.current.state).toBe('unavailable'));
  });

  it('reports unavailable when the request throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network'))),
    );
    const { result } = renderHook(() => useOctoPrint(true));
    await waitFor(() => expect(result.current.state).toBe('unavailable'));
  });

  it('does not poll at all when the overlay is off', async () => {
    const fetchMock = vi.fn((url: string) => jsonFor(url));
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useOctoPrint(false));
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops polling when unmounted', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((url: string) => jsonFor(url));
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = renderHook(() => useOctoPrint(true));
    await act(async () => {});
    const afterFirst = fetchMock.mock.calls.length;

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(CONFIG.printerCam.videoRetryMs);
    });
    expect(fetchMock.mock.calls.length).toBe(afterFirst);
  });
});
