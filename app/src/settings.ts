// Values the viewer can change from the sofa, persisted between launches.
//
// webOS apps load from file://, an opaque origin, so localStorage can throw
// rather than simply return null — every access is wrapped. When it is
// unavailable the value still applies for the session, it just doesn't stick.

const STORE_KEY = 'naktv.settings';

export interface Settings {
  /** Host running go2rtc (phi). IP, not a name: webOS mDNS is unreliable. */
  go2rtcHost: string;
  /** Show print name, times and temperatures over the camera feed. */
  showPrintOverlay: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  go2rtcHost: '172.29.0.36',
  showPrintOverlay: true,
};

/** Dotted-quad only — this is typed on a remote, so keep the check obvious. */
export function isValidHost(value: string): boolean {
  const parts = value.trim().split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function read(): Partial<Settings> {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Partial<Settings>) : {};
  } catch {
    return {};
  }
}

let current: Settings = { ...DEFAULT_SETTINGS, ...read() };
if (!isValidHost(current.go2rtcHost)) current = { ...DEFAULT_SETTINGS };
// Settings stored before the overlay existed carry no boolean at all, and
// `undefined` would spread over the default and render nothing.
if (typeof current.showPrintOverlay !== 'boolean') {
  current = { ...current, showPrintOverlay: DEFAULT_SETTINGS.showPrintOverlay };
}

export function getSettings(): Settings {
  return current;
}

/** Returns the stored settings; an invalid host is rejected and ignored. */
export function saveSettings(update: Partial<Settings>): Settings {
  const next = { ...current, ...update };
  if (!isValidHost(next.go2rtcHost)) return current;
  current = next;
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(current));
  } catch {
    // Session-only. The feed still uses the new host until the app restarts.
  }
  return current;
}

export function resetSettingsForTests(): void {
  current = { ...DEFAULT_SETTINGS };
  try {
    window.localStorage.removeItem(STORE_KEY);
  } catch {
    // nothing to clear
  }
}
