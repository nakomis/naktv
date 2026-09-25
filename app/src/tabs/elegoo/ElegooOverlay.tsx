import type { ElegooStatus } from './cthulhuStatus';
import type { NowPlayingDisplay } from './nowPlaying';

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
 *
 * Spotify's now-playing feed is entirely independent of cthulhu, so it shares
 * the bar regardless of whether the printer status is reachable.
 */
export function ElegooOverlay({
  status,
  nowPlaying = null,
}: {
  status: ElegooStatus;
  nowPlaying?: NowPlayingDisplay | null;
}) {
  return (
    <div className="print-overlay" role="status">
      {status.state === 'unavailable' ? (
        <span className="print-overlay-note">Status unavailable</span>
      ) : (
        <div className="print-overlay-job">
          <span className="print-overlay-name">{status.filename}</span>
          {/* Fixed width: as status cycles Lifting → Exposing → Dropping, the
              fields to its right must not jump sideways with it. */}
          <Field
            label="Status"
            value={status.statusLabel}
            valueClassName="print-overlay-value--status"
          />
          <Field label="Layer" value={status.layer} />
          <Field label="Progress" value={status.percent} />
          <Field label="Total" value={status.total} />
          <Field label="Remaining" value={status.remaining} />
        </div>
      )}
      <NowPlayingFields nowPlaying={nowPlaying} />
    </div>
  );
}

function NowPlayingFields({ nowPlaying }: { nowPlaying: NowPlayingDisplay | null }) {
  if (!nowPlaying) return null;
  const { album, track } = nowPlaying;
  if (!album && !track) return null;

  return (
    <div className="print-overlay-now-playing">
      {album && (
        <Field label="Album" value={album} valueClassName="print-overlay-value--truncate" />
      )}
      {track && (
        <Field label="Track" value={track} valueClassName="print-overlay-value--truncate" />
      )}
    </div>
  );
}

function Field({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <span className="print-overlay-field">
      <span className="print-overlay-label">{label}</span>
      <span className={`print-overlay-value${valueClassName ? ` ${valueClassName}` : ''}`}>
        {value}
      </span>
    </span>
  );
}
