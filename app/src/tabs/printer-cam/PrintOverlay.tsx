import type { PrintStatus } from './useOctoPrint';

/**
 * Print status laid over the top of the camera feed.
 *
 * Read from across a room, so it is one strip rather than a panel: the job on
 * the left, temperatures on the right, nothing that needs scanning. A scrim
 * sits behind it because white text over a brightly lit print bed is
 * unreadable exactly when you most want to read it.
 *
 * Temperatures show whenever OctoPrint answers, since they are worth watching
 * whilst preheating. The job fields appear only during a print, so an idle
 * printer shows a short strip rather than a row of dashes.
 */
export function PrintOverlay({ status }: { status: PrintStatus }) {
  if (status.state === 'unconfigured') {
    return (
      <div className="print-overlay" role="status">
        <span className="print-overlay-note">OctoPrint key not configured</span>
      </div>
    );
  }

  if (status.state === 'unavailable') {
    return (
      <div className="print-overlay" role="status">
        <span className="print-overlay-note">OctoPrint unavailable</span>
      </div>
    );
  }

  const printing = status.state === 'printing';

  return (
    <div className="print-overlay" role="status">
      {printing && (
        <div className="print-overlay-job">
          <span className="print-overlay-name">{status.name}</span>
          <Field label="Started" value={status.startTime} />
          <Field label="Elapsed" value={status.printTime} />
          <Field label="Remaining" value={status.remaining} />
        </div>
      )}
      <div className="print-overlay-temps">
        <Field label="Tool" value={`${status.tool.actual} / ${status.tool.target}`} />
        <Field label="Bed" value={`${status.bed.actual} / ${status.bed.target}`} />
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
