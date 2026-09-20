import { fireEvent, render, screen } from '@testing-library/react';
import { Keys } from '../../keys';
import { DEFAULT_SETTINGS, getSettings, resetSettingsForTests } from '../../settings';
import { SettingsTab } from './Settings';

function press(keyCode: number) {
  fireEvent.keyDown(document, { keyCode });
}

/** Enter edit mode on the address, which is no longer the default. */
function editHost() {
  press(Keys.Enter);
}

describe('SettingsTab', () => {
  beforeEach(resetSettingsForTests);

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
    expect(screen.getByRole('status')).toHaveTextContent('172.29.0.15');
  });

  it('changes the selected octet with up and down whilst editing', () => {
    render(<SettingsTab />);
    editHost();
    press(Keys.Up);
    expect(screen.getByRole('status')).toHaveTextContent('172.29.0.15');
    press(Keys.Down);
    press(Keys.Down);
    expect(screen.getByRole('status')).toHaveTextContent('172.29.0.13');
  });

  it('moves between octets with left and right whilst editing', () => {
    render(<SettingsTab />);
    editHost();
    press(Keys.Left);
    press(Keys.Up);
    expect(screen.getByRole('status')).toHaveTextContent('172.29.1.14');
  });

  it('clamps octets to 0-255', () => {
    render(<SettingsTab />);
    editHost();
    for (let i = 0; i < 20; i += 1) press(Keys.Down);
    expect(screen.getByRole('status')).toHaveTextContent('172.29.0.0');
  });

  it('commits on the second OK and persists the host', () => {
    render(<SettingsTab />);
    editHost();
    press(Keys.Up);
    press(Keys.Enter);
    expect(screen.getByRole('status')).toHaveTextContent('Saved — streaming from 172.29.0.15');
    expect(getSettings().go2rtcHost).toBe('172.29.0.15');
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
});
