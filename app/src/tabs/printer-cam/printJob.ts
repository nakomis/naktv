// Turning OctoPrint's job and printer payloads into the handful of strings the
// overlay shows. Kept pure and separate from the fetching so both halves stay
// easy to test.

/** The slice of `GET /api/job` the overlay uses. */
export interface OctoPrintJob {
  job?: { file?: { name?: string | null } };
  progress?: {
    printTime?: number | null;
    printTimeLeft?: number | null;
  };
  /** "Printing", "Operational", "Offline", … */
  state?: string;
}

/** The slice of `GET /api/printer` the overlay uses. */
export interface OctoPrintPrinter {
  temperature?: {
    tool0?: { actual?: number | null; target?: number | null };
    bed?: { actual?: number | null; target?: number | null };
  };
}

/** Shown wherever OctoPrint has no value to give us yet. */
export const UNKNOWN = '--:--';

/**
 * The human part of a gcode filename.
 *
 * Leia's files are named `<name>_<time>_<layer>_<temp>_<filament>_<printer>`,
 * e.g. `hanger_1h46m_0.20mm_200C_PLA_CR6SE.gcode` — so everything before the
 * first underscore is the bit worth putting on screen. Names may contain
 * spaces ("Ladle Stand"), and a file with no underscore at all still wants its
 * extension removing.
 */
export function printName(filename: string | null | undefined): string {
  if (!filename) return '';
  const withoutExtension = filename.replace(/\.gcode$/i, '');
  const underscore = withoutExtension.indexOf('_');
  return underscore === -1 ? withoutExtension : withoutExtension.slice(0, underscore);
}

/**
 * Seconds as `hh:mm`, not wrapping past a day — a 30-hour print should read
 * `30:00`, not `06:00`. Seconds are discarded rather than rounded, so the
 * remaining time never briefly reads higher than the previous tick.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return UNKNOWN;
  if (seconds < 0) return UNKNOWN;
  const total = Math.floor(seconds / 60);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** A local wall-clock `hh:mm`. */
export function formatClock(when: Date): string {
  return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
}

/**
 * When the print started, worked backwards from how long it has been running.
 *
 * OctoPrint does not report a start timestamp, only elapsed `printTime`, and
 * deriving it each tick keeps the overlay correct across an app reload — which
 * a value captured when the overlay first mounted would not be.
 */
export function startedAt(
  printTimeSeconds: number | null | undefined,
  now: Date = new Date(),
): Date | undefined {
  if (printTimeSeconds === null || printTimeSeconds === undefined) return undefined;
  if (printTimeSeconds < 0) return undefined;
  return new Date(now.getTime() - printTimeSeconds * 1000);
}

/** One decimal place, as OctoPrint's own UI shows temperatures. */
export function formatTemperature(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '--';
  return `${value.toFixed(1)}°C`;
}
