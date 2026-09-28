import { useState } from 'react';
import { layerImageUrl } from '../../config';

/**
 * The layer the resin printer is exposing, as cthulhu decodes it from the
 * print file: the whole plate, white where the LCD lets light through
 * (NAKTV-15).
 *
 * A new layer is a new src. Chromium keeps painting the current image until
 * the new one has loaded, so layers change without a blank frame between
 * them. cthulhu answers 202 while it is still fetching the print file, and
 * the <img> fails on that; it hides, and tries again on the next layer.
 */
export function LayerImage({ layer }: { layer: number }) {
  const src = layerImageUrl(layer);
  // A failure belongs to one URL, so the next layer gets a fresh attempt.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (failedSrc === src) return null;
  return (
    <img
      className="elegoo-layer"
      src={src}
      alt=""
      aria-hidden="true"
      onError={() => setFailedSrc(src)}
    />
  );
}
