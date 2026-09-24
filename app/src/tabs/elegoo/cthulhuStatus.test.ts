import { toElegooStatus, UNAVAILABLE_STATUS } from './cthulhuStatus';

// Trimmed from a real `GET /api/status` response, taken mid-print.
const PRINTING = {
  print: {
    status: 3,
    statusLabel: 'Exposing',
    filename: 'cthulhu.goo',
    currentLayer: 2,
    totalLayer: 2143,
    progressPercent: 0.09,
    remainingMs: 23_904_171,
    totalMs: 23_997_797,
    errorMessage: null,
  },
};

const IDLE = {
  print: {
    status: 0,
    statusLabel: 'Idle',
    filename: null,
    currentLayer: 0,
    totalLayer: 0,
    progressPercent: 0,
    remainingMs: 0,
    totalMs: 0,
    errorMessage: null,
  },
};

describe('toElegooStatus', () => {
  it('reads a print in progress', () => {
    const s = toElegooStatus(PRINTING);
    expect(s.state).toBe('printing');
    expect(s.filename).toBe('cthulhu.goo');
    expect(s.statusLabel).toBe('Exposing');
    expect(s.layer).toBe('2 / 2143');
    expect(s.percent).toBe('0%');
    // 23,904,171 ms ≈ 398.4 minutes ≈ 06:38.
    expect(s.remaining).toBe('06:38');
  });

  it('reports idle when status is 0, dropping the layer count', () => {
    const s = toElegooStatus(IDLE);
    expect(s.state).toBe('idle');
    expect(s.layer).toBe('--:--');
    expect(s.filename).toBe('');
  });

  it('survives a payload with no print field', () => {
    expect(toElegooStatus({})).toEqual(UNAVAILABLE_STATUS);
  });

  it('survives a print field with no status code', () => {
    expect(toElegooStatus({ print: { statusLabel: 'Idle' } })).toEqual(UNAVAILABLE_STATUS);
  });

  it('rounds the percentage rather than showing decimals', () => {
    const s = toElegooStatus({ print: { ...PRINTING.print, progressPercent: 42.6 } });
    expect(s.percent).toBe('43%');
  });
});
