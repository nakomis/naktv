import { CONFIG } from '../../config';
import { getSettings } from '../../settings';
import { CameraFeed } from './CameraFeed';
import { PrintOverlay } from './PrintOverlay';
import { useOctoPrint } from './useOctoPrint';

export function PrinterCam() {
  const showOverlay = getSettings().showPrintOverlay;
  // Polling is skipped entirely when the overlay is off, so a disabled
  // feature costs nothing on the wire or on Leia.
  const printStatus = useOctoPrint(showOverlay);

  return (
    <CameraFeed
      config={CONFIG.printerCam}
      ariaLabel="3D printer camera"
      overlay={showOverlay && <PrintOverlay status={printStatus} />}
    />
  );
}
