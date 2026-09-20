import { act, fireEvent, render, screen } from '@testing-library/react';
import { CONFIG } from '../config';
import { Keys } from '../keys';
import type { TabDefinition } from '../tabs/registry';
import { App } from './App';

const tabs: TabDefinition[] = [
  { id: 'one', title: 'One', Component: () => <p>first panel</p> },
  { id: 'two', title: 'Two', Component: () => <p>second panel</p> },
];

function press(keyCode: number) {
  fireEvent.keyDown(document, { keyCode });
}

function strip() {
  return document.querySelector('.tab-strip') as HTMLElement;
}

describe('App', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows the first tab and a visible strip on launch', () => {
    render(<App tabs={tabs} />);
    expect(screen.getByText('first panel')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'One' })).toHaveAttribute('aria-selected', 'true');
    expect(strip()).not.toHaveClass('hidden');
  });

  it('fades the strip after the idle delay', () => {
    render(<App tabs={tabs} />);
    act(() => vi.advanceTimersByTime(CONFIG.stripHideDelayMs));
    expect(strip()).toHaveClass('hidden');
  });

  it('moves between tabs with Left and Right, clamped at the ends', () => {
    render(<App tabs={tabs} />);
    press(Keys.Right);
    expect(screen.getByText('second panel')).toBeInTheDocument();
    expect(screen.queryByText('first panel')).not.toBeInTheDocument();
    press(Keys.Right);
    expect(screen.getByText('second panel')).toBeInTheDocument();
    press(Keys.Left);
    press(Keys.Left);
    expect(screen.getByText('first panel')).toBeInTheDocument();
  });

  it('only reveals the strip on a keypress while it is hidden', () => {
    render(<App tabs={tabs} />);
    act(() => vi.advanceTimersByTime(CONFIG.stripHideDelayMs));
    press(Keys.Right);
    expect(strip()).not.toHaveClass('hidden');
    expect(screen.getByText('first panel')).toBeInTheDocument();
  });

  it('keeps the strip up while keys are being pressed', () => {
    render(<App tabs={tabs} />);
    act(() => vi.advanceTimersByTime(CONFIG.stripHideDelayMs - 500));
    press(Keys.Enter);
    act(() => vi.advanceTimersByTime(CONFIG.stripHideDelayMs - 500));
    expect(strip()).not.toHaveClass('hidden');
  });

  it('dismisses the strip with Down, and Down does not bring it back', () => {
    render(<App tabs={tabs} />);
    press(Keys.Down);
    expect(strip()).toHaveClass('hidden');
    press(Keys.Down);
    expect(strip()).toHaveClass('hidden');
    press(Keys.Up);
    expect(strip()).not.toHaveClass('hidden');
  });

  it.each([Keys.Back, Keys.Escape])('exits on key %i, whether or not the strip is up', (key) => {
    const onExit = vi.fn();
    render(<App tabs={tabs} onExit={onExit} />);
    press(key);
    act(() => vi.advanceTimersByTime(CONFIG.stripHideDelayMs));
    press(key);
    expect(onExit).toHaveBeenCalledTimes(2);
  });

  it('selects a tab when clicked with the Magic Remote pointer', () => {
    render(<App tabs={tabs} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Two' }));
    expect(screen.getByText('second panel')).toBeInTheDocument();
  });

  it.each(['webOSRelaunch', 'mousemove'])('reveals the strip on %s', (type) => {
    render(<App tabs={tabs} />);
    act(() => vi.advanceTimersByTime(CONFIG.stripHideDelayMs));
    fireEvent(document, new Event(type));
    expect(strip()).not.toHaveClass('hidden');
  });

  it('uses the real tab registry by default', () => {
    render(<App />);
    expect(screen.getByRole('tab', { name: 'Printer Cam' })).toBeInTheDocument();
  });
});
