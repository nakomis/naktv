import { act, fireEvent, render, screen } from '@testing-library/react';
import { CONFIG } from '../../config';
import { DEFAULT_SETTINGS, resetSettingsForTests } from '../../settings';
import { ElegooCam } from './ElegooCam';

// The MSE/MJPEG mechanics themselves are covered by PrinterCam.test.tsx —
// CameraFeed is shared, so these only need to check what's specific to this
// tab: the stream name and the fallback URL.
describe('ElegooCam', () => {
  let socketUrls: string[];

  beforeEach(() => {
    resetSettingsForTests();
    socketUrls = [];
    vi.stubGlobal(
      'WebSocket',
      class {
        static readonly OPEN = 1;
        binaryType = 'arraybuffer';
        onopen: ((e: Event) => void) | null = null;
        onclose: ((e: Event) => void) | null = null;
        onerror: ((e: Event) => void) | null = null;
        onmessage: ((e: MessageEvent) => void) | null = null;
        constructor(url: string) {
          socketUrls.push(url);
        }
        send() {}
        close() {}
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) })),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const settle = async () => {
    await act(async () => {});
  };

  it('starts on the go2rtc resin_av stream from the configured host', async () => {
    vi.useFakeTimers();
    render(<ElegooCam />);
    await settle();
    expect(screen.getByLabelText('Elegoo resin printer camera').tagName).toBe('VIDEO');
    expect(socketUrls[0]).toContain(DEFAULT_SETTINGS.go2rtcHost);
    expect(socketUrls[0]).toContain('src=resin_av');
  });

  it('falls back to cthulhu’s camera service once the reconnects are spent', () => {
    vi.useFakeTimers();
    render(<ElegooCam />);
    for (let attempt = 0; attempt <= 3; attempt += 1) {
      const video = screen.queryByLabelText('Elegoo resin printer camera');
      if (!video) break;
      act(() => {
        fireEvent.error(video);
        vi.advanceTimersByTime(CONFIG.elegooCam.reconnectDelayMs + 10);
      });
    }
    const img = screen.getByRole('img', { name: 'Elegoo resin printer camera' });
    expect(img.getAttribute('src')).toContain(CONFIG.elegooCam.streamUrl);
  });

  it('shows the status-unavailable note rather than breaking the video', async () => {
    render(<ElegooCam />);
    await settle();
    expect(await screen.findByText('Status unavailable')).toBeInTheDocument();
    expect(screen.getByLabelText('Elegoo resin printer camera')).toBeInTheDocument();
  });
});
