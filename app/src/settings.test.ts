import {
  DEFAULT_SETTINGS,
  getSettings,
  isValidHost,
  resetSettingsForTests,
  saveSettings,
} from './settings';

describe('settings', () => {
  beforeEach(resetSettingsForTests);

  it('defaults to phi', () => {
    expect(getSettings().go2rtcHost).toBe('172.29.0.14');
  });

  it('accepts dotted quads only', () => {
    expect(isValidHost('10.0.0.1')).toBe(true);
    expect(isValidHost('255.255.255.255')).toBe(true);
    expect(isValidHost('256.0.0.1')).toBe(false);
    expect(isValidHost('10.0.0')).toBe(false);
    expect(isValidHost('phi.local')).toBe(false);
    expect(isValidHost('')).toBe(false);
  });

  it('saves a valid host and rejects an invalid one', () => {
    expect(saveSettings({ go2rtcHost: '10.1.2.3' }).go2rtcHost).toBe('10.1.2.3');
    expect(saveSettings({ go2rtcHost: '999.1.2.3' }).go2rtcHost).toBe('10.1.2.3');
  });

  it('survives localStorage being unavailable', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    try {
      expect(saveSettings({ go2rtcHost: '10.9.9.9' }).go2rtcHost).toBe('10.9.9.9');
      expect(getSettings().go2rtcHost).toBe('10.9.9.9');
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });

  it('exposes the default separately from the current value', () => {
    saveSettings({ go2rtcHost: '10.1.2.3' });
    expect(DEFAULT_SETTINGS.go2rtcHost).toBe('172.29.0.14');
  });
});
