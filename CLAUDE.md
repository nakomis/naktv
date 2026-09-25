# naktv

A webOS launcher app for the LG B3 (77" OLED, webOS 23): a tab strip of views,
starting with the 3D printer camera. Launched by the NakTV button in
`nakomis/tv-remote`.

## AWS credentials

- Sandbox: `AWS_PROFILE=nakom.is-sandbox`
- Production: `AWS_PROFILE=nakom.is-admin`

The only AWS resources are the CI roles (`infra/`), plus the dev-mode token in
SSM (`/naktv/devmode-session-token`, prod), which the keepalive in
`home-servers` reads.

## Platform constraints — read before changing the build

- **The TV runs Chromium 108**, confirmed from its user agent. The build target
  is `chrome108` and nothing is polyfilled. Tailwind 4 needs 111+, so the CSS
  is plain.
- **Keep the bundle a classic script.** Apps load from `file://` (null origin),
  and module scripts and `crossorigin` tags are refused, which leaves a black
  screen. `vite.config.ts` builds an IIFE and rewrites the tags. Don't add code
  splitting or dynamic `import()`.
- **Never name a global `status`.** It aliases `window.status`. With React
  modules this can't happen by accident, but it bit the prototype.
- **Use IPs, not `.local` names.** webOS mDNS is unreliable.
- **Don't set `requiredACG`** in `appinfo.json` without testing the screen-saver
  veto on the TV. A declared list may shut off the Luna calls that work today.
- `ares-launch` re-focuses a running instance rather than loading a new build.
  `scripts/install-tv.sh` closes the app first.

### Android TV

`android/` hosts the same `app/dist` build inside a Kotlin WebView, for the
Sony Bravia. It is a separate constraint set from webOS, not a relaxation of
it — the web app itself is unchanged and doesn't know which platform it's on:

- **Back doesn't reach the page for free.** Android's hardware Back key is
  intercepted in `MainActivity` and turned into a synthetic `keydown` with
  `keyCode: 27` (Escape) via `evaluateJavascript` — `isBack()` in `keys.ts`
  already treats that as Back, so nothing there needed to change.
- **`window.close()` is a no-op on a top-level WebView.** It only does
  anything for a popup opened with `window.open()`, which this page never
  does. `MainActivity` overrides it after each load to call a
  `NakTVAndroid.exit()` JS bridge instead, which finishes the Activity.
- **`allowUniversalAccessFromFileURLs` does the same job it does on webOS**:
  letting the `file://` page fetch cthulhu's `/api/status`, which sends no
  CORS headers.
- **The network security config has to say cleartext is allowed too.**
  API 28 (the TV's Android version) lets a `networkSecurityConfig` element
  override `usesCleartextTraffic` in the manifest rather than working
  alongside it, so both have to grant it.
- Gradle wants a JDK the Android Gradle Plugin accepts; `android/.tool-versions`
  pins one via asdf (Corretto 25/18, the system defaults, are not it).

## Verifying on the TV

Tests run in jsdom. To check the real thing, install with `pnpm run install-tv`,
then start `pnpm exec ares-inspect --device b3 --app com.nakomis.naktv`. It
prints a local DevTools port. `http://localhost:<port>/json/list` gives the
page's websocket, and `Runtime.evaluate` over it can read the DOM (for example
the `<img>`'s `naturalWidth` and bounding rect). `Page.captureScreenshot` hangs,
because the page is composited over the video plane.

## Repository layout

```
app/        Vite + React + TS webOS app (pnpm, Biome, Vitest)
android/    Kotlin WebView shell hosting app/dist on Android TV (Gradle)
infra/      CDK GithubCiStack (pnpm, Jest)
scripts/    install-tv.sh, install-android.sh
docs/       logo, candidates, architecture diagram
```

## Testing

- `cd app && pnpm lint && pnpm typecheck && pnpm test` (70% line floor)
- `cd infra && pnpm typecheck && pnpm test`

## Architecture diagrams

Source: `docs/architecture/naktv.drawio`. The SVG is regenerated on commit by
`.githooks/pre-commit`.

To activate the hook after cloning:
```bash
git config core.hooksPath .githooks
```
