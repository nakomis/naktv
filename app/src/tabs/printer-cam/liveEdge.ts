// Once the player is behind it stays behind — there is no "catch up" for a
// live stream the element treats as a file. Watching a print that way, you see
// your own hand touch the bed seconds after it happened.
//
// So we nudge it: whenever the buffered end runs further ahead than maxLagMs,
// seek to just short of it. A seek is visible as a small jump, so the
// threshold is well above normal jitter.
//
// targetMs must leave real buffer in hand. The feed now arrives over MSE
// (mseClient.ts), where we append the SourceBuffer ourselves and a seek lands
// exactly where we put it, with no browser-managed buffer behind it. Landing
// close to the edge therefore starves the decoder outright: playback stalls,
// the buffer refills, this seeks back onto the edge, and it starves again —
// visible as the picture hanging a second at a time, indefinitely. Both
// values live in config.ts and are deliberately generous.

export interface LiveEdgeConfig {
  /** Lag beyond which we skip forward. */
  liveEdgeMaxLagMs: number;
  /** How far behind the buffered end to land. */
  liveEdgeTargetMs: number;
}

/** The parts of HTMLVideoElement this needs — keeps it testable. */
export interface SeekableMedia {
  currentTime: number;
  readonly buffered: { readonly length: number; end(index: number): number };
}

/**
 * Skips to the live edge if the player has fallen behind.
 * Returns true if it seeked, for tests and logging.
 */
export function seekToLiveEdge(media: SeekableMedia, config: LiveEdgeConfig): boolean {
  const { buffered } = media;
  if (buffered.length === 0) return false;
  const end = buffered.end(buffered.length - 1);
  const lagMs = (end - media.currentTime) * 1000;
  if (lagMs <= config.liveEdgeMaxLagMs) return false;
  const target = end - config.liveEdgeTargetMs / 1000;
  if (target <= media.currentTime) return false;
  media.currentTime = target;
  return true;
}
