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
  it('formats a track and artist when something is playing', () => {
    const display = toNowPlayingDisplay({
      track: 'Time',
      album: 'Inception (Music from the Motion Picture)',
      artists: ['Hans Zimmer'],
      playing: true,
      updatedAt: '2026-09-24T12:00:00Z',
    });
    expect(display).toEqual({ track: 'Time', artist: 'Hans Zimmer' });
  });

  it('bills every credited artist, not just the first', () => {
    const display = toNowPlayingDisplay({
      track: 'Under Pressure',
      artists: ['Queen', 'David Bowie'],
      playing: true,
    });
    expect(display).toEqual({ track: 'Under Pressure', artist: 'Queen, David Bowie' });
  });

  it('leaves a bracket in an artist name alone', () => {
    // trimParenthetical is for "(Remastered 2011)" on a title. A bracket in an
    // artist name is part of the name, so the artist must not go through it.
    const display = toNowPlayingDisplay({
      track: 'Teen Age Riot',
      artists: ['Sonic Youth (Live)'],
      playing: true,
    });
    expect(display?.artist).toBe('Sonic Youth (Live)');
  });

  it('drops blank and whitespace-only artist entries', () => {
    const display = toNowPlayingDisplay({
      track: 'Time',
      artists: ['Hans Zimmer', '  ', ''],
      playing: true,
    });
    expect(display?.artist).toBe('Hans Zimmer');
  });

  it('shows nothing when paused', () => {
    expect(
      toNowPlayingDisplay({ track: 'Time', artists: ['Hans Zimmer'], playing: false }),
    ).toBeNull();
  });

  it('shows nothing when there is no payload', () => {
    expect(toNowPlayingDisplay(undefined)).toBeNull();
    expect(toNowPlayingDisplay(null)).toBeNull();
  });

  it('shows nothing when playing is true but both fields are empty', () => {
    expect(toNowPlayingDisplay({ track: '', artists: [], playing: true })).toBeNull();
  });

  it('shows nothing when the album is the only thing on offer', () => {
    // The album is no longer rendered, so a payload carrying only an album has
    // nothing the overlay can show.
    expect(toNowPlayingDisplay({ album: 'Inception', playing: true })).toBeNull();
  });

  it('copes with a track and no artist, or an artist and no track', () => {
    expect(toNowPlayingDisplay({ track: 'Time', playing: true })).toEqual({
      track: 'Time',
      artist: '',
    });
    expect(toNowPlayingDisplay({ artists: ['Hans Zimmer'], playing: true })).toEqual({
      track: '',
      artist: 'Hans Zimmer',
    });
  });
});
