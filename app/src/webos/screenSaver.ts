// webOS puts its screen saver over any app that isn't playing video once the
// remote has been idle for a while — fatal for a camera feed watched from the
// sofa. The TV asks registered clients first; answering ack:false vetoes it.
//
// PalmServiceBridge is the Luna bus binding webOS injects into every web app
// (webOSTV.js is only a wrapper round it). Each call needs its own bridge.

interface PalmServiceBridge {
  onservicecallback: ((message: string) => void) | null;
  call(uri: string, params: string): void;
}

type BridgeConstructor = new () => PalmServiceBridge;

const CLIENT = 'naktv';
const SERVICE = 'luna://com.webos.service.tvpower/power';

function bridgeConstructor(): BridgeConstructor | undefined {
  return (globalThis as { PalmServiceBridge?: BridgeConstructor }).PalmServiceBridge;
}

// Held at module scope so the subscription isn't garbage-collected.
let subscription: PalmServiceBridge | undefined;

/** Returns false when not running on webOS (a desktop browser, or tests). */
export function keepScreenSaverAway(): boolean {
  const Bridge = bridgeConstructor();
  if (!Bridge || subscription) return Boolean(subscription);

  subscription = new Bridge();
  subscription.onservicecallback = (message) => {
    let payload: { state?: string; timestamp?: number };
    try {
      payload = JSON.parse(message);
    } catch {
      return;
    }
    if (payload.state !== 'Active' || payload.timestamp === undefined) return;
    const reply = new Bridge();
    reply.call(
      `${SERVICE}/responseScreenSaverRequest`,
      JSON.stringify({ clientName: CLIENT, ack: false, timestamp: payload.timestamp }),
    );
  };
  subscription.call(
    `${SERVICE}/registerScreenSaverRequest`,
    JSON.stringify({ subscribe: true, clientName: CLIENT }),
  );
  return true;
}

/** Test seam: forget the subscription. */
export function resetScreenSaverForTests(): void {
  subscription = undefined;
}
