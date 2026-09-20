import { useEffect, useState } from 'react';
import { CONFIG, hasOctoPrintKey } from '../../config';
import {
  formatClock,
  formatDuration,
  formatTemperature,
  type OctoPrintJob,
  type OctoPrintPrinter,
  printName,
  startedAt,
  UNKNOWN,
} from './printJob';

export type PrintState =
  /** No API key was baked in — a build made without AWS credentials. */
  | 'unconfigured'
  /** OctoPrint did not answer, or answered with an error. */
  | 'unavailable'
  /** Reachable, but not printing. Temperatures are still worth showing. */
  | 'idle'
  | 'printing';

export interface PrintStatus {
  state: PrintState;
  name: string;
  startTime: string;
  printTime: string;
  remaining: string;
  tool: { actual: string; target: string };
  bed: { actual: string; target: string };
}

const EMPTY: PrintStatus = {
  state: 'unavailable',
  name: '',
  startTime: UNKNOWN,
  printTime: UNKNOWN,
  remaining: UNKNOWN,
  tool: { actual: '--', target: '--' },
  bed: { actual: '--', target: '--' },
};

/** Shape the two payloads into what the overlay renders. */
export function toStatus(job: OctoPrintJob, printer: OctoPrintPrinter): PrintStatus {
  const printing = job.state === 'Printing';
  const started = startedAt(job.progress?.printTime);
  return {
    state: printing ? 'printing' : 'idle',
    name: printing ? printName(job.job?.file?.name) : '',
    startTime: printing && started ? formatClock(started) : UNKNOWN,
    printTime: printing ? formatDuration(job.progress?.printTime) : UNKNOWN,
    remaining: printing ? formatDuration(job.progress?.printTimeLeft) : UNKNOWN,
    tool: {
      actual: formatTemperature(printer.temperature?.tool0?.actual),
      target: formatTemperature(printer.temperature?.tool0?.target),
    },
    bed: {
      actual: formatTemperature(printer.temperature?.bed?.actual),
      target: formatTemperature(printer.temperature?.bed?.target),
    },
  };
}

/**
 * Polls OctoPrint for job and temperature state.
 *
 * Both endpoints are fetched together each tick — two small JSON documents,
 * cheaper to ask for than to reason about staggering. Each poll carries its
 * own timeout so a slow or missing Leia cannot let requests accumulate, and
 * the whole thing stops when the overlay is switched off so a disabled
 * feature costs nothing.
 */
export function useOctoPrint(enabled: boolean): PrintStatus {
  const [status, setStatus] = useState<PrintStatus>(
    hasOctoPrintKey() ? EMPTY : { ...EMPTY, state: 'unconfigured' },
  );

  useEffect(() => {
    if (!enabled) return;
    if (!hasOctoPrintKey()) {
      setStatus({ ...EMPTY, state: 'unconfigured' });
      return;
    }

    let cancelled = false;
    const { baseUrl, apiKey, pollIntervalMs, timeoutMs } = CONFIG.octoPrint;

    const poll = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const [job, printer] = await Promise.all(
          ['/api/job', '/api/printer'].map(async (path) => {
            const response = await fetch(`${baseUrl}${path}`, {
              headers: { 'X-Api-Key': apiKey },
              signal: controller.signal,
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
          }),
        );
        if (!cancelled) setStatus(toStatus(job as OctoPrintJob, printer as OctoPrintPrinter));
      } catch {
        // Unreachable, timed out, or a bad key. The overlay says so rather
        // than freezing on values that have stopped being true.
        if (!cancelled) setStatus({ ...EMPTY, state: 'unavailable' });
      } finally {
        clearTimeout(timer);
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
