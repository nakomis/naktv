import { fireEvent, render, screen } from '@testing-library/react';
import { Keys } from '../../keys';
import { DEFAULT_SETTINGS, getSettings, resetSettingsForTests } from '../../settings';
import { SettingsTab } from './Settings';

function press(keyCode: number) {
  fireEvent.keyDown(document, { keyCode });
}

describe('SettingsTab', () => {
  beforeEach(resetSettingsForTests);

  it('shows the current host as four octets, last one selected', () => {
    render(<SettingsTab />);
    const shown = screen.getAllByText(/^\d+$/).map((el) => el.textContent);
    expect(shown.join('.')).toBe(DEFAULT_SETTINGS.go2rtcHost);
    expect(screen.getByRole('status')).toHaveTextContent(DEFAULT_SETTINGS.go2rtcHost);
  });

  it('changes the selected octet with up and down', () => {
    render(<SettingsTab />);
    press(Keys.Up);
    expect(screen.getByRole('status')).toHaveTextContent('172.29.0.15');
    press(Keys.Down);
    press(Keys.Down);
    expect(screen.getByRole('status')).toHaveTextContent('172.29.0.13');
  });

  it('moves between octets with left and right', () => {
    render(<SettingsTab />);
    press(Keys.Left);
    press(Keys.Up);
    expect(screen.getByRole('status')).toHaveTextContent('172.29.1.14');
  });

  it('clamps octets to 0-255', () => {
    render(<SettingsTab />);
    for (let i = 0; i < 20; i += 1) press(Keys.Down);
    expect(screen.getByRole('status')).toHaveTextContent('172.29.0.0');
  });

  it('saves on OK and persists the host', () => {
    render(<SettingsTab />);
    press(Keys.Up);
    press(Keys.Enter);
    expect(screen.getByRole('status')).toHaveTextContent('Saved — streaming from 172.29.0.15');
    expect(getSettings().go2rtcHost).toBe('172.29.0.15');
  });

  it('does not save until OK is pressed', () => {
    render(<SettingsTab />);
    press(Keys.Up);
    expect(getSettings().go2rtcHost).toBe(DEFAULT_SETTINGS.go2rtcHost);
  });
});
