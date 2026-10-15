// The feed's music source (NAKTV-26), held on the feed box, not in the TV's
// settings: it decides what every camera stream carries, recordings included,
// so the TV only asks for it and asks to change it.

import { musicSourceUrl } from './config';

export type MusicSource = 'spotify' | 'library';

const TIMEOUT_MS = 4000;

function parse(body: unknown): MusicSource | null {
  const source = (body as { source?: unknown } | null)?.source;
  return source === 'spotify' || source === 'library' ? source : null;
}

async function call(init?: RequestInit): Promise<MusicSource | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(musicSourceUrl(), { ...init, signal: controller.signal });
    return response.ok ? parse(await response.json()) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The current source, or null if the feed box can't be reached. */
export function fetchMusicSource(): Promise<MusicSource | null> {
  return call();
}

/** Sets the source; resolves to what the feed box now reports, or null. */
export function setMusicSource(source: MusicSource): Promise<MusicSource | null> {
  return call({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  });
}
