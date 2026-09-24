import type { ElegooStatus } from './cthulhuStatus';

/**
 * Print status for the Elegoo Mars 5 Ultra, laid over the camera feed in the
 * same style as PrintOverlay (see printer-cam/PrintOverlay.tsx) — a single
 * strip readable from across the room. Resin printers report layers and
 * exposure progress rather than nozzle/bed temperatures, so there is no
 * temperature row here.
 *
 * cthulhu does not send CORS headers yet (see useCthulhu.ts), so on the TV
 * this fetch fails until that ships. Rather than a loud error, an unreachable
 * cthulhu shows only a small note — the video keeps playing either way.
 */
export function ElegooOverlay({ status }: { status: ElegooStatus }) {
  if (status.state === 'unavailable') {
    return (
      <div className="print-overlay" role="status">
        <span className="print-overlay-note">Status unavailable</span>
      </div>
    );
  }

  return (
    <div className="print-overlay" role="status">
      <div className="print-overlay-job">
        <span className="print-overlay-name">{status.filename}</span>
        <Field label="Status" value={status.statusLabel} />
        <Field label="Layer" value={status.layer} />
        <Field label="Progress" value={status.percent} />
        <Field label="Remaining" value={status.remaining} />
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <span className="print-overlay-field">
      <span className="print-overlay-label">{label}</span>
      <span className="print-overlay-value">{value}</span>
    </span>
  );
}
