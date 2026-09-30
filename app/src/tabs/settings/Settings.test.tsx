import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { musicSourceUrl } from '../../config';
import { Keys } from '../../keys';
import { DEFAULT_SETTINGS, getSettings, resetSettingsForTests } from '../../settings';
import { SettingsTab } from './Settings';

/**
 * The expected address after nudging one octet. Derived from the default
 * rather than written out, so moving the feed host does not mean editing
 * every assertion here — these tests are about the key handling, not the IP.
 */
function octet(delta: number, index = 3): string {
  const parts = DEFAULT_SETTINGS.go2rtcHost.split('.').map(Number);
  parts[index] += delta;
  return parts.join('.');
}

function press(keyCode: number) {
  fireEvent.keyDown(document, { keyCode });
}

/** Enter edit mode on the address, which is no longer the default. */
function editHost() {
  press(Keys.Enter);
}

/**
 * A stand-in for the feed box's /music-source: answers GET with `source`,
 * and POST by adopting whatever was asked for. `null` means unreachable.
 */
function stubFeedBox(initial: string | null) {
  let source = initial;
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (source === null) throw new TypeError('Failed to fetch');
    if (init?.method === 'POST') source = JSON.parse(String(init.body)).source;
    return new Response(JSON.stringify({ source }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('SettingsTab', () => {
  beforeEach(() => {
    resetSettingsForTests();
    stubFeedBox('spotify');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the current host as four octets', () => {
    render(<SettingsTab />);
    const shown = screen.getAllByText(/^\d+$/).map((el) => el.textContent);
    expect(shown.join('.')).toBe(DEFAULT_SETTINGS.go2rtcHost);
  });

  // The bug this modal model exists to fix: arriving at the tab and pressing
  // Down to reach the next setting silently decremented the address instead.
  it('does not touch the address when navigating away from it', () => {
    render(<SettingsTab />);
    press(Keys.Down);
    press(Keys.Down);
    expect(screen.getByRole('status')).toHaveTextContent(DEFAULT_SETTINGS.go2rtcHost);
  });

  it('reaches the print overlay with Down, which was unreachable before', () => {
    render(<SettingsTab />);
    press(Keys.Down);
    press(Keys.Enter);
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(getSettings().showPrintOverlay).toBe(false);
  });

  it('toggles the overlay back on, saving each time', () => {
    render(<SettingsTab />);
    press(Keys.Down);
    press(Keys.Enter);
    press(Keys.Enter);
    expect(screen.getByText('On')).toBeInTheDocument();
    expect(getSettings().showPrintOverlay).toBe(true);
  });

  it('ignores Up and Down on the address until OK opens it for editing', () => {
    render(<SettingsTab />);
    press(Keys.Up);
    expect(screen.getByRole('status')).toHaveTextContent(DEFAULT_SETTINGS.go2rtcHost);

    editHost();
    press(Keys.Up);
    expect(screen.getByRole('status')).toHaveTextContent(octet(1));
  });

  it('changes the selected octet with up and down whilst editing', () => {
    render(<SettingsTab />);
    editHost();
    press(Keys.Up);
    expect(screen.getByRole('status')).toHaveTextContent(octet(1));
    press(Keys.Down);
    press(Keys.Down);
    expect(screen.getByRole('status')).toHaveTextContent(octet(-1));
  });

  it('moves between octets with left and right whilst editing', () => {
    render(<SettingsTab />);
    editHost();
    press(Keys.Left);
    press(Keys.Up);
    expect(screen.getByRole('status')).toHaveTextContent(octet(1, 2));
  });

  it('clamps octets to 0-255', () => {
    render(<SettingsTab />);
    editHost();
    // Enough presses to reach zero from any default, with margin — the point
    // is that it stops at 0 rather than going negative.
    const start = Number(DEFAULT_SETTINGS.go2rtcHost.split('.')[3]);
    for (let i = 0; i < start + 5; i += 1) press(Keys.Down);
    const zeroed = [...DEFAULT_SETTINGS.go2rtcHost.split('.').slice(0, 3), '0'].join('.');
    expect(screen.getByRole('status')).toHaveTextContent(zeroed);
  });

  it('commits on the second OK and persists the host', () => {
    render(<SettingsTab />);
    editHost();
    press(Keys.Up);
    press(Keys.Enter);
    expect(screen.getByRole('status')).toHaveTextContent(`Saved — streaming from ${octet(1)}`);
    expect(getSettings().go2rtcHost).toBe(octet(1));
  });

  it('does not save whilst still editing', () => {
    render(<SettingsTab />);
    editHost();
    press(Keys.Up);
    expect(getSettings().go2rtcHost).toBe(DEFAULT_SETTINGS.go2rtcHost);
  });

  // Committing steps back out, so Down then reaches the overlay rather than
  // carrying on editing the address.
  it('leaves edit mode after committing', () => {
    render(<SettingsTab />);
    editHost();
    press(Keys.Enter);
    press(Keys.Down);
    press(Keys.Enter);
    expect(getSettings().showPrintOverlay).toBe(false);
  });

  describe('music', () => {
    function toMusic() {
      press(Keys.Down);
      press(Keys.Down);
    }

    it('shows the source the feed box reports', async () => {
      render(<SettingsTab />);
      expect(await screen.findByText('Spotify')).toBeInTheDocument();
    });

    it('switches to the library on OK, and back again', async () => {
      const fetchMock = stubFeedBox('spotify');
      render(<SettingsTab />);
      await screen.findByText('Spotify');
      toMusic();
      press(Keys.Enter);
      expect(await screen.findByText('Library')).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith(
        musicSourceUrl(),
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ source: 'library' }) }),
      );
      press(Keys.Enter);
      expect(await screen.findByText('Spotify')).toBeInTheDocument();
    });

    it('says so when the feed box cannot be reached', async () => {
      stubFeedBox(null);
      render(<SettingsTab />);
      expect(await screen.findByText('Unavailable')).toBeInTheDocument();
    });

    it('leaves the overlay alone', async () => {
      render(<SettingsTab />);
      await screen.findByText('Spotify');
      toMusic();
      press(Keys.Enter);
      await screen.findByText('Library');
      expect(getSettings().showPrintOverlay).toBe(true);
    });
  });
});
