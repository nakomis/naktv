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
    const m = media(4, 10);
    expect(seekToLiveEdge(m, CONFIG.printerCam)).toBe(true);
    // Lands just short of the buffered end, not exactly on it.
    expect(m.currentTime).toBeCloseTo(10 - CONFIG.printerCam.liveEdgeTargetMs / 1000, 3);
    expect(m.currentTime).toBeLessThan(10);
  });

  it('never seeks backwards', () => {
    const m = media(9.99, 10);
    expect(seekToLiveEdge(m, CONFIG.printerCam)).toBe(false);
    expect(m.currentTime).toBe(9.99);
  });
});
