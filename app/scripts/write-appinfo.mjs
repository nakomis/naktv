// Copies the webOS app manifest and icons into dist/, stamping the version.
//
// The version comes from version.json, which CI writes from the shared
// deployment tracker (nakomis-infra compute-version). Local builds have no
// version.json and fall back to 0.0.0 — ares-package requires x.y.z.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const version = existsSync('version.json')
  ? JSON.parse(readFileSync('version.json', 'utf-8')).version
  : '0.0.0';

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`version.json holds "${version}"; webOS needs a plain x.y.z version`);
}

const appinfo = JSON.parse(readFileSync('webos/appinfo.json', 'utf-8'));
writeFileSync('dist/appinfo.json', `${JSON.stringify({ ...appinfo, version }, null, 2)}\n`);
writeFileSync('dist/version.json', `${JSON.stringify({ version })}\n`);
for (const icon of ['icon.png', 'icon-large.png']) {
  copyFileSync(`webos/${icon}`, `dist/${icon}`);
}
console.log(`dist/appinfo.json → ${appinfo.id} ${version}`);
