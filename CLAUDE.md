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
infra/      CDK GithubCiStack (pnpm, Jest)
scripts/    install-tv.sh
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
