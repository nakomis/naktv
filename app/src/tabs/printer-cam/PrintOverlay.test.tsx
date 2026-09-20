import { render, screen } from '@testing-library/react';
import { PrintOverlay } from './PrintOverlay';
import type { PrintStatus } from './useOctoPrint';

const base: PrintStatus = {
  state: 'printing',
  name: 'hanger',
  startTime: '19:30',
  printTime: '01:40',
  remaining: '00:10',
  tool: { actual: '200.0°C', target: '200.0°C' },
  bed: { actual: '60.0°C', target: '60.0°C' },
};

describe('PrintOverlay', () => {
  it('shows the job and the temperatures whilst printing', () => {
    render(<PrintOverlay status={base} />);
    expect(screen.getByText('hanger')).toBeInTheDocument();
    expect(screen.getByText('19:30')).toBeInTheDocument();
    expect(screen.getByText('01:40')).toBeInTheDocument();
    expect(screen.getByText('00:10')).toBeInTheDocument();
    expect(screen.getByText('200.0°C / 200.0°C')).toBeInTheDocument();
    expect(screen.getByText('60.0°C / 60.0°C')).toBeInTheDocument();
  });

  // An idle printer has nothing to say about elapsed or remaining, and a row
  // of dashes is worse than no row.
  it('drops the job fields when idle but keeps temperatures', () => {
    render(<PrintOverlay status={{ ...base, state: 'idle', name: '' }} />);
    expect(screen.queryByText('Started')).not.toBeInTheDocument();
    expect(screen.queryByText('Remaining')).not.toBeInTheDocument();
    expect(screen.getByText('Tool')).toBeInTheDocument();
  });

  it('says so when OctoPrint cannot be reached', () => {
    render(<PrintOverlay status={{ ...base, state: 'unavailable' }} />);
    expect(screen.getByText('OctoPrint unavailable')).toBeInTheDocument();
    expect(screen.queryByText('hanger')).not.toBeInTheDocument();
  });

  // The case a CI-built .ipk lands in: no key was available at build time.
  it('says so when no API key was built in', () => {
    render(<PrintOverlay status={{ ...base, state: 'unconfigured' }} />);
    expect(screen.getByText('OctoPrint key not configured')).toBeInTheDocument();
  });

  it('is announced as a status region rather than read as decoration', () => {
    render(<PrintOverlay status={base} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
