import { useCallback, useEffect, useState } from 'react';
import { Keys } from '../../keys';
import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../../settings';

/**
 * Sets the go2rtc host, driven entirely by the remote's arrow keys.
 *
 * Typing an address with a TV remote and the on-screen keyboard is miserable,
 * so the address is four octets: Left/Right pick one, Up/Down change it (held
 * arrows repeat, and ±10 with OK-free shortcuts isn't worth the complexity).
 * Changes apply on save, and the Printer Cam re-tries H.264 immediately.
 *
 * The tab strip owns Left/Right at the shell level only while it is visible;
 * it hides after a few seconds, which is when this tab sees the arrows.
 *
 * The print overlay toggle rides the same cursor rather than introducing a
 * second interaction model: Right past the last octet lands on it, and Up/Down
 * flips it exactly as they change a number.
 */
/** Cursor position of the overlay toggle: one past the four octets. */
const OVERLAY_FIELD = 4;
export function SettingsTab() {
  const [octets, setOctets] = useState<number[]>(() =>
    getSettings().go2rtcHost.split('.').map(Number),
  );
  const [selected, setSelected] = useState(3);
  const [overlay, setOverlay] = useState(() => getSettings().showPrintOverlay);
  const [saved, setSaved] = useState<string | null>(null);

  const host = octets.join('.');

  const bump = useCallback(
    (delta: number) => {
      if (selected === OVERLAY_FIELD) {
        setOverlay((on) => !on);
        setSaved(null);
        return;
      }
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
      switch (event.keyCode) {
        case Keys.Left:
          setSelected((index) => Math.max(0, index - 1));
          break;
        case Keys.Right:
          setSelected((index) => Math.min(OVERLAY_FIELD, index + 1));
          break;
        case Keys.Up:
          bump(1);
          break;
        case Keys.Down:
          bump(-1);
          break;
        case Keys.Enter: {
          const stored = saveSettings({
            go2rtcHost: octets.join('.'),
            showPrintOverlay: overlay,
          });
          setSaved(stored.go2rtcHost);
          break;
        }
        default:
          return;
      }
      event.preventDefault();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [bump, octets, overlay]);

  return (
    <div className="settings">
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
            className={index === selected ? 'octet selected' : 'octet'}
            aria-current={index === selected ? 'true' : undefined}
          >
            {value}
          </span>
        ))}
      </fieldset>
      <h1>Print overlay</h1>
      <p className="hint">
        Print name, times and temperatures from OctoPrint, over the camera feed.
      </p>
      <p
        className={selected === OVERLAY_FIELD ? 'octet selected' : 'octet'}
        aria-current={selected === OVERLAY_FIELD ? 'true' : undefined}
      >
        {overlay ? 'On' : 'Off'}
      </p>
      <p className="hint">Left/Right to move, Up/Down to change, OK to save.</p>
      <p className="saved" role="status">
        {saved ? `Saved — streaming from ${saved}` : `Editing ${host}`}
      </p>
    </div>
  );
}
