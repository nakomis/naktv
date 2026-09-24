import { CONFIG } from '../../config';
import { getSettings } from '../../settings';
import { CameraFeed } from '../printer-cam/CameraFeed';
import { ElegooOverlay } from './ElegooOverlay';
import { useCthulhu } from './useCthulhu';

export function ElegooCam() {
  const showOverlay = getSettings().showPrintOverlay;
  // Polling is skipped entirely when the overlay is off, so a disabled
  // feature costs nothing on the wire or on phi.
  const status = useCthulhu(showOverlay);

  return (
    <CameraFeed
      config={CONFIG.elegooCam}
      ariaLabel="Elegoo resin printer camera"
      overlay={showOverlay && <ElegooOverlay status={status} />}
    />
  );
}
