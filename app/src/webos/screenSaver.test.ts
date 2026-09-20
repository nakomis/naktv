import { keepScreenSaverAway, resetScreenSaverForTests } from './screenSaver';

interface Call {
  uri: string;
  params: Record<string, unknown>;
}

function installFakeBridge() {
  const calls: Call[] = [];
  const bridges: FakeBridge[] = [];
  class FakeBridge {
    onservicecallback: ((message: string) => void) | null = null;
    constructor() {
      bridges.push(this);
    }
    call(uri: string, params: string) {
      calls.push({ uri, params: JSON.parse(params) });
    }
  }
  (globalThis as Record<string, unknown>).PalmServiceBridge = FakeBridge;
  return { calls, bridges };
}

describe('keepScreenSaverAway', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).PalmServiceBridge;
    resetScreenSaverForTests();
  });

  it('does nothing outside webOS', () => {
    expect(keepScreenSaverAway()).toBe(false);
  });

  it('subscribes once to screen-saver requests', () => {
    const { calls } = installFakeBridge();
    expect(keepScreenSaverAway()).toBe(true);
    expect(keepScreenSaverAway()).toBe(true);
    expect(calls).toEqual([
      {
        uri: 'luna://com.webos.service.tvpower/power/registerScreenSaverRequest',
        params: { subscribe: true, clientName: 'naktv' },
      },
    ]);
  });

  it('vetoes each screen-saver request, quoting its timestamp', () => {
    const { calls, bridges } = installFakeBridge();
    keepScreenSaverAway();
    bridges[0].onservicecallback?.(JSON.stringify({ state: 'Active', timestamp: 42 }));
    expect(calls[1]).toEqual({
      uri: 'luna://com.webos.service.tvpower/power/responseScreenSaverRequest',
      params: { clientName: 'naktv', ack: false, timestamp: 42 },
    });
  });

  it('ignores the subscription acknowledgement and malformed messages', () => {
    const { calls, bridges } = installFakeBridge();
    keepScreenSaverAway();
    bridges[0].onservicecallback?.(JSON.stringify({ returnValue: true, subscribed: true }));
    bridges[0].onservicecallback?.('not json');
    expect(calls).toHaveLength(1);
  });
});
