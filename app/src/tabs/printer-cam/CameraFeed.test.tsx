import { act, fireEvent, render, screen } from '@testing-library/react';
import { CONFIG } from '../../config';
import { resetSettingsForTests } from '../../settings';
import { FakeMediaSource, FakeSocket, reply } from '../../test/mseHarness';
import { CameraFeed } from './CameraFeed';
import { RESUME_SETTLE_MS } from './usePageVisible';

/**
 * NAKTV-8: the feed lets go of go2rtc while the app is in the background and
 * comes back with a fresh MediaSource on return. Driven through the same
 * hand-operated fakes as mseClient's own tests, so each step is explicit.
 */
describe('CameraFeed in the background (NAKTV-8)', () => {
  const config = CONFIG.printerCam;

  function setHidden(hidden: boolean) {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  const videoElement = () => screen.getByLabelText('3D printer camera') as HTMLVideoElement;

  /** Opens the latest MediaSource and lets go2rtc answer, as on a good connection. */
  function connect() {
    act(() => {
      FakeMediaSource.last?.open();
      FakeSocket.last?.onopen?.(new Event('open'));
      reply();
    });
  }

  function renderPlaying() {
    render(<CameraFeed config={config} ariaLabel="3D printer camera" />);
    connect();
    act(() => {
      fireEvent.playing(videoElement());
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    resetSettingsForTests();
    FakeMediaSource.last = undefined;
    FakeMediaSource.created = 0;
    FakeSocket.last = undefined;
    FakeSocket.all = [];
    vi.stubGlobal('MediaSource', FakeMediaSource);
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    setHidden(false);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('closes the socket and empties the video when the app is hidden', () => {
    renderPlaying();
    const socket = FakeSocket.last;
    expect(socket?.closed).toBe(false);

    act(() => setHidden(true));

    expect(socket?.closed).toBe(true);
    expect(videoElement().hasAttribute('src')).toBe(false);
  });

  it('closes the socket on pagehide even without a visibilitychange', () => {
    renderPlaying();
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(FakeSocket.last?.closed).toBe(true);
  });

  it('neither falls back nor retries while hidden', () => {
    renderPlaying();
    act(() => setHidden(true));
    act(() => {
      vi.advanceTimersByTime(config.videoRetryMs * 2);
    });
    expect(FakeSocket.all).toHaveLength(1);
    expect(videoElement().tagName).toBe('VIDEO');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('reconnects with a fresh MediaSource once visible again', () => {
    renderPlaying();
    const firstSource = FakeMediaSource.last;
    act(() => setHidden(true));

    act(() => setHidden(false));
    // Not straight away: a return has to settle first.
    expect(FakeMediaSource.last).toBe(firstSource);

    act(() => {
      vi.advanceTimersByTime(RESUME_SETTLE_MS);
    });
    expect(FakeMediaSource.last).not.toBe(firstSource);
    expect(videoElement().getAttribute('src')).toBe('blob:naktv-test');
    // Muted again, or webOS won't autoplay it unattended.
    expect(videoElement().muted).toBe(true);

    connect();
    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.last?.closed).toBe(false);
  });

  it('says it is reconnecting until the video plays again', () => {
    renderPlaying();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    act(() => setHidden(true));
    act(() => setHidden(false));
    act(() => {
      vi.advanceTimersByTime(RESUME_SETTLE_MS);
    });
    connect();
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting…');

    act(() => {
      fireEvent.playing(videoElement());
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('reconnects once after a run of rapid hide/show toggles', () => {
    renderPlaying();
    act(() => setHidden(true));

    for (let toggle = 0; toggle < 5; toggle += 1) {
      act(() => setHidden(false));
      act(() => {
        vi.advanceTimersByTime(RESUME_SETTLE_MS / 4);
      });
      act(() => setHidden(true));
    }
    act(() => setHidden(false));
    act(() => {
      vi.advanceTimersByTime(RESUME_SETTLE_MS * 3);
    });
    connect();

    // One MediaSource and socket for the first connection, one for the return.
    expect(FakeMediaSource.created).toBe(2);
    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[0].closed).toBe(true);
    expect(FakeSocket.all[1].closed).toBe(false);
  });

  it('falls back again if the resumed feed does not play', () => {
    renderPlaying();
    act(() => setHidden(true));
    act(() => setHidden(false));
    act(() => {
      vi.advanceTimersByTime(RESUME_SETTLE_MS);
    });
    connect();
    // Silent from here on: the timeout starts afresh, then the retries run.
    act(() => {
      vi.advanceTimersByTime(config.videoTimeoutMs + 100);
      vi.advanceTimersByTime(config.reconnectDelayMs + 10);
    });
    connect();
    expect(FakeSocket.all).toHaveLength(3);
  });

  it('drops the MJPEG fallback while hidden and keeps to it on return', () => {
    render(<CameraFeed config={config} ariaLabel="3D printer camera" />);
    for (let attempt = 0; attempt <= 3; attempt += 1) {
      act(() => {
        fireEvent.error(videoElement());
        vi.advanceTimersByTime(config.reconnectDelayMs + 10);
      });
    }
    const img = screen.getByRole('img', { name: '3D printer camera' });

    act(() => setHidden(true));
    expect(img.isConnected).toBe(false);
    expect(img.getAttribute('src')).toMatch(/^data:/);
    // The H.264 retry is paused with everything else.
    act(() => {
      vi.advanceTimersByTime(config.videoRetryMs + 100);
    });
    expect(screen.queryByLabelText('3D printer camera')).not.toBeInTheDocument();

    act(() => setHidden(false));
    act(() => {
      vi.advanceTimersByTime(RESUME_SETTLE_MS);
    });
    expect(screen.getByRole('img', { name: '3D printer camera' }).getAttribute('src')).toContain(
      config.streamUrl,
    );
    expect(screen.getByText('MJPEG')).toBeInTheDocument();
  });
});
