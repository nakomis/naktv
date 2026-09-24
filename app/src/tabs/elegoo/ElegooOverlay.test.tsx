import { render, screen } from '@testing-library/react';
import type { ElegooStatus } from './cthulhuStatus';
import { ElegooOverlay } from './ElegooOverlay';

const base: ElegooStatus = {
  state: 'printing',
  filename: 'cthulhu.goo',
  statusLabel: 'Exposing',
  layer: '2 / 2143',
  percent: '0%',
  remaining: '06:38',
};

describe('ElegooOverlay', () => {
  it('shows the filename, status, layer, progress and remaining time', () => {
    render(<ElegooOverlay status={base} />);
    expect(screen.getByText('cthulhu.goo')).toBeInTheDocument();
    expect(screen.getByText('Exposing')).toBeInTheDocument();
    expect(screen.getByText('2 / 2143')).toBeInTheDocument();
    expect(screen.getByText('0%')).toBeInTheDocument();
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
});
