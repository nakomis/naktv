// The tab the app last showed, so a relaunch opens where the viewer left off
// (NAKTV-28). Stored by id, not index, so adding or reordering tabs in the
// registry can't send it to the wrong one.
//
// localStorage can throw on webOS's file:// origin (see settings.ts), so every
// access is wrapped; without storage the app simply opens on the first tab.

const STORE_KEY = 'naktv.lastTab';

export function loadLastTab(): string | null {
  try {
    return window.localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}

export function saveLastTab(id: string): void {
  try {
    window.localStorage.setItem(STORE_KEY, id);
  } catch {
    // Session-only: the next launch opens on the first tab.
  }
}
