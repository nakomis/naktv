import { useEffect, useState } from 'react';

/**
 * How long the page must stay visible before a feed comes back (NAKTV-8).
 *
 * Long enough that a run of hide/show toggles - flicking through the webOS
 * launcher bar, say - settles into one reconnect rather than one per toggle;
 * short enough that nobody waits on it.
 */
export const RESUME_SETTLE_MS = 1000;

/**
 * Whether the app is in the foreground, for feeds that should let go of their
 * connections while it isn't (NAKTV-8).
 *
 * Going hidden takes effect at once: the point is to stop pulling a stream
 * nobody is watching, and the TV may suspend the page's timers soon after it
 * goes to the background, so a delayed teardown might never run. Coming back
 * waits `settleMs`, and any hide in the meantime cancels it, so rapid toggles
 * cost at most one teardown and one reconnect.
 *
 * webOS reports backgrounding as an ordinary visibilitychange. pagehide covers
 * the page being unloaded or frozen without one; pageshow and webOSRelaunch
 * (the NakTV button pressed while the app is already running) are only cues
 * to look at `document.hidden` again.
 */
export function usePageVisible(settleMs: number = RESUME_SETTLE_MS): boolean {
  const [visible, setVisible] = useState(() => !document.hidden);

  useEffect(() => {
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;

    const hide = () => {
      clearTimeout(resumeTimer);
      resumeTimer = undefined;
      setVisible(false);
    };
    const check = () => {
      if (document.hidden) {
        hide();
        return;
      }
      clearTimeout(resumeTimer);
      resumeTimer = setTimeout(() => {
        resumeTimer = undefined;
        setVisible(true);
      }, settleMs);
    };

    document.addEventListener('visibilitychange', check);
    document.addEventListener('webOSRelaunch', check);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', check);
    return () => {
      clearTimeout(resumeTimer);
      document.removeEventListener('visibilitychange', check);
      document.removeEventListener('webOSRelaunch', check);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', check);
    };
  }, [settleMs]);

  return visible;
}
