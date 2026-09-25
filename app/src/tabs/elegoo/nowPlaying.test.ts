import { toNowPlayingDisplay, trimParenthetical } from './nowPlaying';

describe('trimParenthetical', () => {
  it('drops everything from the first opening parenthesis, trimmed', () => {
    expect(trimParenthetical('Interstellar (Original Motion Picture Soundtrack)')).toBe(
      'Interstellar',
    );
  });

  it('leaves a title with no parenthesis untouched', () => {
    expect(trimParenthetical('Time')).toBe('Time');
  });

  it('trims trailing whitespace left behind by the cut', () => {
    expect(trimParenthetical('Time  (Remastered 2011)')).toBe('Time');
  });
});

describe('toNowPlayingDisplay', () => {
  it('formats a track and album when something is playing', () => {
    const display = toNowPlayingDisplay({
      track: 'Time',
      album: 'Inception (Music from the Motion Picture)',
      artists: ['Hans Zimmer'],
      playing: true,
      updatedAt: '2026-09-24T12:00:00Z',
    });
    expect(display).toEqual({ track: 'Time', album: 'Inception' });
  });

  it('shows nothing when paused', () => {
    expect(toNowPlayingDisplay({ track: 'Time', album: 'Inception', playing: false })).toBeNull();
  });

  it('shows nothing when there is no payload', () => {
    expect(toNowPlayingDisplay(undefined)).toBeNull();
    expect(toNowPlayingDisplay(null)).toBeNull();
  });

  it('shows nothing when playing is true but both fields are empty', () => {
    expect(toNowPlayingDisplay({ track: '', album: '', playing: true })).toBeNull();
  });

  it('copes with a track and no album, or an album and no track', () => {
    expect(toNowPlayingDisplay({ track: 'Time', playing: true })).toEqual({
      track: 'Time',
      album: '',
    });
    expect(toNowPlayingDisplay({ album: 'Inception', playing: true })).toEqual({
      track: '',
      album: 'Inception',
    });
  });
});
