import { useEffect, useState } from 'react';
import { CONFIG } from '../../config';
import type { ElegooStatus } from './cthulhuStatus';
import { toElegooStatus, UNAVAILABLE_STATUS } from './cthulhuStatus';

/**
 * Polls cthulhu for the Elegoo Mars 5 Ultra's print status.
 *
 * One endpoint rather than OctoPrint's two, and no API key — cthulhu is a
 * LAN-only service with nothing to authenticate. Otherwise the same shape as
 * useOctoPrint: each poll carries its own timeout so a slow or missing
 * cthulhu cannot let requests pile up, an `inFlight` guard stops a slow poll
 * overlapping the next tick, and polling stops entirely when the overlay is
 * off, so a disabled feature costs nothing.
 *
 * IMPORTANT: cthulhu does not send CORS headers yet (a fix is being deployed
 * separately, after the print running as this was written finishes), so until
 * then every fetch from the TV's file:// origin fails and this reports
 * 'unavailable' — which the overlay already treats as "hide quietly", not as
 * an error worth shouting about.
 */
export function useCthulhu(enabled: boolean): ElegooStatus {
  const [status, setStatus] = useState<ElegooStatus>(UNAVAILABLE_STATUS);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let inFlight = false;
    const { baseUrl, pollIntervalMs, timeoutMs } = CONFIG.cthulhu;

    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${baseUrl}/api/status`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!cancelled) setStatus(toElegooStatus(data));
      } catch {
        // Unreachable, timed out, or (today) blocked by the missing CORS
        // headers. The overlay says so quietly rather than freezing on
        // values that have stopped being true.
        if (!cancelled) setStatus(UNAVAILABLE_STATUS);
      } finally {
        clearTimeout(timer);
        inFlight = false;
      }
    };

    void poll();
    const interval = setInterval(poll, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [enabled]);

  return status;
}
