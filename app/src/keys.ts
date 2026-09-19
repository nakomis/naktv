// Key codes sent by the LG remote. Arrows and OK are standard; Back is webOS's
// own (461) — Escape is kept so the app can be driven from a desktop browser.
export const Keys = {
  Left: 37,
  Up: 38,
  Right: 39,
  Down: 40,
  Enter: 13,
  Back: 461,
  Escape: 27,
} as const;

export function isBack(keyCode: number): boolean {
  return keyCode === Keys.Back || keyCode === Keys.Escape;
}
