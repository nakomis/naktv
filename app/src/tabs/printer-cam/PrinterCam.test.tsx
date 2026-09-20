import { act, fireEvent, render, screen } from '@testing-library/react';
import { CONFIG } from '../../config';
import { DEFAULT_SETTINGS, resetSettingsForTests, saveSettings } from '../../settings';
import { PrinterCam } from './PrinterCam';

describe('PrinterCam', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetSettingsForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts on the go2rtc H.264 stream from the configured host', () => {
    render(<PrinterCam />);
    const video = screen.getByLabelText('3D printer camera');
    expect(video.tagName).toBe('VIDEO');
    expect(video.getAttribute('src')).toContain(DEFAULT_SETTINGS.go2rtcHost);
    expect(video.getAttribute('src')).toContain('stream.mp4');
  });

  it('asks for the stream carrying the muxed Spotify audio track', () => {
    render(<PrinterCam />);
    expect(screen.getByLabelText('3D printer camera').getAttribute('src')).toContain(
      'src=printer_av',
    );
  });

  // webOS only autoplays unattended when the element is muted, so it must start
  // that way — but staying muted would discard the audio track in the stream.
  it('starts muted so webOS will autoplay it', () => {
    render(<PrinterCam />);
    expect((screen.getByLabelText('3D printer camera') as HTMLVideoElement).muted).toBe(true);
  });

  it('unmutes once frames are flowing, so the Spotify track is audible', () => {
    render(<PrinterCam />);
    const video = screen.getByLabelText('3D printer camera') as HTMLVideoElement;
    act(() => {
      fireEvent.playing(video);
    });
    expect(video.muted).toBe(false);
  });

  it('uses the host saved in settings', () => {
    saveSettings({ go2rtcHost: '10.0.0.9' });
    render(<PrinterCam />);
    expect(screen.getByLabelText('3D printer camera').getAttribute('src')).toContain('10.0.0.9');
  });

  it('falls back to the MJPEG feed when the video errors', () => {
    render(<PrinterCam />);
    act(() => {
      fireEvent.error(screen.getByLabelText('3D printer camera'));
    });
    const img = screen.getByRole('img', { name: '3D printer camera' });
    expect(img.getAttribute('src')).toContain(CONFIG.printerCam.streamUrl);
  });

  it('falls back when the video never starts playing', () => {
    render(<PrinterCam />);
    act(() => {
      vi.advanceTimersByTime(CONFIG.printerCam.videoTimeoutMs + 100);
    });
    expect(screen.getByRole('img', { name: '3D printer camera' })).toBeInTheDocument();
  });

  it('stays on video once it is playing', () => {
    render(<PrinterCam />);
    act(() => {
      fireEvent.playing(screen.getByLabelText('3D printer camera'));
      vi.advanceTimersByTime(CONFIG.printerCam.videoTimeoutMs + 100);
    });
    expect(screen.getByLabelText('3D printer camera').tagName).toBe('VIDEO');
  });

  it('retries H.264 after a spell on the fallback', () => {
    render(<PrinterCam />);
    act(() => {
      fireEvent.error(screen.getByLabelText('3D printer camera'));
    });
    expect(screen.getByRole('img', { name: '3D printer camera' })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(CONFIG.printerCam.videoRetryMs + 100);
    });
    expect(screen.getByLabelText('3D printer camera').tagName).toBe('VIDEO');
  });
});
