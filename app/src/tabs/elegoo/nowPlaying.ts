// Turning Rey's `now-playing.json` (written by feed/bin/now-playing.py, a
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
  artist: string;
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
 *
 * `album` is still in the payload and deliberately unused: the overlay shows
 * the artist instead, which identifies what is playing from across the room in
 * a way an album title usually does not.
 *
 * Artists are NOT put through trimParenthetical. That exists to strip
 * "(Remastered 2011)" and "(Original Motion Picture Soundtrack)" from titles;
 * a bracket in an artist name is part of the name.
 */
export function toNowPlayingDisplay(
  data: NowPlayingPayload | undefined | null,
): NowPlayingDisplay | null {
  if (!data?.playing) return null;
  const track = trimParenthetical(data.track ?? '');
  // librespot gives every credited artist. Joined rather than taking the
  // first, so a collaboration does not silently lose half its billing.
  const artist = (data.artists ?? [])
    .map((name) => name?.trim())
    .filter((name): name is string => Boolean(name))
    .join(', ');
  if (!track && !artist) return null;
  return { track, artist };
}
