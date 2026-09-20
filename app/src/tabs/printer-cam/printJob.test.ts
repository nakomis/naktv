import { formatClock, formatDuration, printName, startedAt } from './printJob';

describe('printName', () => {
  // Real filenames from Leia, which follow <name>_<time>_<layer>_<temp>_<filament>_<printer>
  it('takes everything before the first underscore', () => {
    expect(printName('hanger_1h46m_0.20mm_200C_PLA_CR6SE.gcode')).toBe('hanger');
  });

  it('keeps spaces in the name', () => {
    expect(printName('Ladle Stand_35m_0.20mm_215C_PLA_CR6SE.gcode')).toBe('Ladle Stand');
  });

  it('drops the extension when there is no underscore at all', () => {
    expect(printName('calibration.gcode')).toBe('calibration');
  });

  it('survives nothing to work with', () => {
    expect(printName(undefined)).toBe('');
    expect(printName('')).toBe('');
  });
});

describe('formatDuration', () => {
  it('renders hours and minutes, discarding seconds', () => {
    expect(formatDuration(6034)).toBe('01:40'); // 1h 40m 34s
  });

  it('pads both halves', () => {
    expect(formatDuration(655)).toBe('00:10'); // 10m 55s
    expect(formatDuration(0)).toBe('00:00');
  });

  it('does not wrap past a day', () => {
    expect(formatDuration(90_000)).toBe('25:00');
  });

  // OctoPrint sends null for printTimeLeft until it has an estimate.
  it('shows placeholders when the value is missing', () => {
    expect(formatDuration(null)).toBe('--:--');
    expect(formatDuration(undefined)).toBe('--:--');
  });

  it('treats a negative estimate as unknown rather than rendering nonsense', () => {
    expect(formatDuration(-5)).toBe('--:--');
  });
});

describe('formatClock', () => {
  it('renders a zero-padded 24-hour local time', () => {
    expect(formatClock(new Date(2026, 8, 20, 9, 5))).toBe('09:05');
    expect(formatClock(new Date(2026, 8, 20, 19, 42))).toBe('19:42');
  });
});

describe('startedAt', () => {
  it('works backwards from how long the print has been running', () => {
    const now = new Date(2026, 8, 20, 20, 30);
    expect(formatClock(startedAt(3600, now) as Date)).toBe('19:30');
  });

  it('is unknown when the elapsed time is', () => {
    expect(startedAt(null, new Date())).toBeUndefined();
  });
});
