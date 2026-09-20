import { useCallback, useEffect, useState } from 'react';
import { Keys } from '../../keys';
import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../../settings';

/**
 * Settings, driven entirely by the remote's arrow keys.
 *
 * Two modes, because with only four arrows and an OK button the alternative
 * does not work: if Up/Down always changed the selected octet there would be
 * no way to move off the address at all, and arriving at the tab and pressing
 * Down to "go to the address" would silently decrement it instead.
 *
 * So Up/Down move between rows, and OK acts on whichever row has focus. On the
 * address that means entering edit mode — where Left/Right pick an octet and
 * Up/Down change it — and OK again commits and steps back out. On the overlay
 * it simply toggles.
 *
 * The tab strip owns Left/Right at the shell level only while it is visible;
 * it hides after a few seconds, which is when this tab sees the arrows.
 */
const HOST_ROW = 0;
const OVERLAY_ROW = 1;

export function SettingsTab() {
  const [octets, setOctets] = useState<number[]>(() =>
    getSettings().go2rtcHost.split('.').map(Number),
  );
  const [row, setRow] = useState(HOST_ROW);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState(3);
  const [overlay, setOverlay] = useState(() => getSettings().showPrintOverlay);
  const [saved, setSaved] = useState<string | null>(null);

  const host = octets.join('.');

  const bump = useCallback(
    (delta: number) => {
      setOctets((current) =>
        current.map((value, index) =>
          index === selected ? Math.max(0, Math.min(255, value + delta)) : value,
        ),
      );
      setSaved(null);
    },
    [selected],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (editing) {
        switch (event.keyCode) {
          case Keys.Left:
            setSelected((index) => Math.max(0, index - 1));
            break;
          case Keys.Right:
            setSelected((index) => Math.min(3, index + 1));
            break;
          case Keys.Up:
            bump(1);
            break;
          case Keys.Down:
            bump(-1);
            break;
          case Keys.Enter: {
            const stored = saveSettings({ go2rtcHost: octets.join('.') });
            setSaved(stored.go2rtcHost);
            setEditing(false);
            break;
          }
          default:
            return;
        }
        event.preventDefault();
        return;
      }

      switch (event.keyCode) {
        case Keys.Up:
          setRow((current) => Math.max(HOST_ROW, current - 1));
          break;
        case Keys.Down:
          setRow((current) => Math.min(OVERLAY_ROW, current + 1));
          break;
        case Keys.Enter:
          if (row === HOST_ROW) {
            setEditing(true);
            setSaved(null);
          } else {
            const next = !overlay;
            setOverlay(next);
            saveSettings({ showPrintOverlay: next });
            setSaved(null);
          }
          break;
        default:
          return;
      }
      event.preventDefault();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [bump, editing, octets, overlay, row]);

  const rowClass = (which: number) => (row === which && !editing ? 'setting focused' : 'setting');

  return (
    <div className="settings">
      <div className={rowClass(HOST_ROW)}>
        <h1>Stream host</h1>
        <p className="hint">
          The machine running go2rtc, which re-encodes the camera for the TV. Default{' '}
          {DEFAULT_SETTINGS.go2rtcHost} (phi).
        </p>
        <fieldset className="octets">
          <legend className="visually-hidden">go2rtc host address</legend>
          {octets.map((value, index) => (
            <span
              // Position is the identity here: four fixed slots, never reordered.
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length address
              key={index}
              className={editing && index === selected ? 'octet selected' : 'octet'}
              aria-current={editing && index === selected ? 'true' : undefined}
            >
              {value}
            </span>
          ))}
        </fieldset>
      </div>

      <div className={rowClass(OVERLAY_ROW)}>
        <h1>Print overlay</h1>
        <p className="hint">
          Print name, times and temperatures from OctoPrint, over the camera feed.
        </p>
        <p className="octet">{overlay ? 'On' : 'Off'}</p>
      </div>

      <p className="hint">
        {editing
          ? 'Left/Right to pick a number, Up/Down to change it, OK when done.'
          : 'Up/Down to move, OK to change.'}
      </p>
      <p className="saved" role="status">
        {saved ? `Saved — streaming from ${saved}` : editing ? `Editing ${host}` : host}
      </p>
    </div>
  );
}
