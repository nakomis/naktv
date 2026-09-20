import { CONFIG } from '../../config';
import { seekToLiveEdge } from './liveEdge';

function media(currentTime: number, bufferedEnd?: number) {
  return {
    currentTime,
    buffered: {
      length: bufferedEnd === undefined ? 0 : 1,
      end: () => bufferedEnd ?? 0,
    },
  };
}

describe('seekToLiveEdge', () => {
  it('does nothing before anything is buffered', () => {
    const m = media(0);
    expect(seekToLiveEdge(m, CONFIG.printerCam)).toBe(false);
    expect(m.currentTime).toBe(0);
  });

  it('leaves a player that is near the edge alone', () => {
    const m = media(9.5, 10);
    expect(seekToLiveEdge(m, CONFIG.printerCam)).toBe(false);
    expect(m.currentTime).toBe(9.5);
  });

  it('skips forward when the player has fallen behind', () => {
    // Derived from config rather than hardcoded, so retuning the thresholds
    // does not silently turn this into a test of the no-op path.
    const end = 100;
    const lagged = end - CONFIG.printerCam.liveEdgeMaxLagMs / 1000 - 1;
    const m = media(lagged, end);
    expect(seekToLiveEdge(m, CONFIG.printerCam)).toBe(true);
    // Lands short of the buffered end, not on it.
    expect(m.currentTime).toBeCloseTo(end - CONFIG.printerCam.liveEdgeTargetMs / 1000, 3);
    expect(m.currentTime).toBeLessThan(end);
  });

  // The feed arrives over MSE, where a seek lands exactly where we put it with
  // no browser-managed buffer behind it. Landing near the edge starves the
  // decoder, which stalls, refills, gets seeked onto the edge again — the
  // picture hanging a second at a time, indefinitely. Guard the headroom.
  it('leaves enough buffer after seeking not to starve MSE', () => {
    expect(CONFIG.printerCam.liveEdgeTargetMs).toBeGreaterThanOrEqual(2000);
    expect(CONFIG.printerCam.liveEdgeMaxLagMs).toBeGreaterThan(CONFIG.printerCam.liveEdgeTargetMs);
  });

  it('never seeks backwards', () => {
    const m = media(9.99, 10);
    expect(seekToLiveEdge(m, CONFIG.printerCam)).toBe(false);
    expect(m.currentTime).toBe(9.99);
  });
});
