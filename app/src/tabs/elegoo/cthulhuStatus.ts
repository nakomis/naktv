// Turning cthulhu's `GET /api/status` payload into the handful of strings the
// Elegoo overlay shows. Kept pure and separate from the fetching so both
// halves stay easy to test — the same split printer-cam/printJob.ts uses for
// OctoPrint.
import { formatDuration, UNKNOWN } from '../printer-cam/printJob';

/** The slice of cthulhu's `GET /api/status` the overlay uses. */
export interface CthulhuStatus {
  print?: {
    /** 0 is Idle; anything else is some stage of an active print. */
    status?: number;
    statusLabel?: string;
    filename?: string | null;
    currentLayer?: number | null;
    totalLayer?: number | null;
    progressPercent?: number | null;
    remainingMs?: number | null;
    totalMs?: number | null;
    errorMessage?: string | null;
  };
}

export type ElegooState =
  /** cthulhu did not answer, answered with an error, or hasn't been asked. */
  | 'unavailable'
  /** Reachable, but not printing. */
  | 'idle'
  | 'printing';

export interface ElegooStatus {
  state: ElegooState;
  filename: string;
  statusLabel: string;
  /** `current / total`, or UNKNOWN when there is no job to count layers of. */
  layer: string;
  percent: string;
  remaining: string;
}

/** cthulhu's own idle code — see cthulhu's SDCP status parser. */
const IDLE_STATUS = 0;

const NO_PERCENT = '--%';

export const UNAVAILABLE_STATUS: ElegooStatus = {
  state: 'unavailable',
  filename: '',
  statusLabel: '',
  layer: UNKNOWN,
  percent: NO_PERCENT,
  remaining: UNKNOWN,
};

/** Layer count as `current / total`, or UNKNOWN when there is no job. */
function formatLayer(current: number | null | undefined, total: number | null | undefined): string {
  if (!total) return UNKNOWN;
  return `${current ?? 0} / ${total}`;
}

/** A whole-number percentage — resin exposure progress isn't worth a decimal. */
function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return NO_PERCENT;
  return `${Math.round(value)}%`;
}

/** Milliseconds as `hh:mm`, reusing printJob's seconds-based formatter. */
function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return UNKNOWN;
  return formatDuration(ms / 1000);
}

/** Shape cthulhu's status payload into what the overlay renders. */
export function toElegooStatus(data: CthulhuStatus): ElegooStatus {
  const print = data.print;
  if (!print || print.status === undefined) return UNAVAILABLE_STATUS;

  return {
    state: print.status === IDLE_STATUS ? 'idle' : 'printing',
    filename: print.filename ?? '',
    statusLabel: print.statusLabel ?? '',
    layer: formatLayer(print.currentLayer, print.totalLayer),
    percent: formatPercent(print.progressPercent),
    remaining: formatDurationMs(print.remainingMs),
  };
}
