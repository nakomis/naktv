// Turning phi's `now-playing.json` (written by feed/bin/now-playing.py, a
// librespot --onevent hook) into the pair of strings the Elegoo overlay
// shows. Kept pure and separate from the fetching, the same split as
// cthulhuStatus.ts and OctoPrint's printJob.ts.

/** The shape `now-playing.json` is written in. */
export interface NowPlayingPayload {
  track?: string | null;
  album?: string | null;
  artists?: string[] | null;
  uri?: string | null;
  playing?: boolean | null;
  updatedAt?: string | null;
}

export interface NowPlayingDisplay {
  track: string;
  album: string;
}

/**
 * Drops everything from the first "(" onwards, trimmed.
 *
 * Spotify titles carry things like "(Original Motion Picture Soundtrack)" or
 * "(Remastered 2011)" that are only noise from across the room.
 */
export function trimParenthetical(value: string): string {
  const index = value.indexOf('(');
  const cut = index === -1 ? value : value.slice(0, index);
  return cut.trim();
}

/**
 * Shapes `now-playing.json` into what the overlay renders, or `null` when
 * there is nothing worth showing — nothing playing, or a payload too stale or
 * malformed to trust. Silence here is deliberate: a missing or wrong now-
 * playing feed should never make the print overlay look broken.
 */
export function toNowPlayingDisplay(
  data: NowPlayingPayload | undefined | null,
): NowPlayingDisplay | null {
  if (!data?.playing) return null;
  const track = trimParenthetical(data.track ?? '');
  const album = trimParenthetical(data.album ?? '');
  if (!track && !album) return null;
  return { track, album };
}
