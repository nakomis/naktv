import { render, screen } from '@testing-library/react';
import type { ElegooStatus } from './cthulhuStatus';
import { ElegooOverlay } from './ElegooOverlay';

const base: ElegooStatus = {
  state: 'printing',
  filename: 'cthulhu.goo',
  statusLabel: 'Exposing',
  layer: '2 / 2143',
  percent: '0%',
  total: '06:39',
  remaining: '06:38',
};

describe('ElegooOverlay', () => {
  it('shows the filename, status, layer, progress, total and remaining time', () => {
    render(<ElegooOverlay status={base} />);
    expect(screen.getByText('cthulhu.goo')).toBeInTheDocument();
    expect(screen.getByText('Exposing')).toBeInTheDocument();
    expect(screen.getByText('2 / 2143')).toBeInTheDocument();
    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(screen.getByText('06:39')).toBeInTheDocument();
    expect(screen.getByText('06:38')).toBeInTheDocument();
  });

  // No nozzle or bed on a resin printer — nothing here should look for one.
  it('shows no temperature fields', () => {
    render(<ElegooOverlay status={base} />);
    expect(screen.queryByText('Tool')).not.toBeInTheDocument();
    expect(screen.queryByText('Bed')).not.toBeInTheDocument();
  });

  it('degrades to a small note when cthulhu cannot be reached', () => {
    render(<ElegooOverlay status={{ ...base, state: 'unavailable' }} />);
    expect(screen.getByText('Status unavailable')).toBeInTheDocument();
    expect(screen.queryByText('cthulhu.goo')).not.toBeInTheDocument();
  });

  it('is announced as a status region rather than read as decoration', () => {
    render(<ElegooOverlay status={base} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows nothing Spotify-related when nowPlaying is not given', () => {
    render(<ElegooOverlay status={base} />);
    expect(screen.queryByText('Album')).not.toBeInTheDocument();
    expect(screen.queryByText('Track')).not.toBeInTheDocument();
  });

  it('shows the album and track when Spotify is playing', () => {
    render(<ElegooOverlay status={base} nowPlaying={{ album: 'Inception', track: 'Time' }} />);
    expect(screen.getByText('Album')).toBeInTheDocument();
    expect(screen.getByText('Inception')).toBeInTheDocument();
    expect(screen.getByText('Track')).toBeInTheDocument();
    expect(screen.getByText('Time')).toBeInTheDocument();
  });

  it('shows only the field Spotify actually reported', () => {
    render(<ElegooOverlay status={base} nowPlaying={{ album: '', track: 'Time' }} />);
    expect(screen.queryByText('Album')).not.toBeInTheDocument();
    expect(screen.getByText('Track')).toBeInTheDocument();
  });

  it('still shows now-playing when cthulhu is unavailable', () => {
    render(
      <ElegooOverlay
        status={{ ...base, state: 'unavailable' }}
        nowPlaying={{ album: 'Inception', track: 'Time' }}
      />,
    );
    expect(screen.getByText('Status unavailable')).toBeInTheDocument();
    expect(screen.getByText('Time')).toBeInTheDocument();
  });
});
