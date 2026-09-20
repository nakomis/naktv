import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Visible on mount, hidden `delayMs` after the last `reveal()`. `hide()` drops
 * it immediately. The returned callbacks are stable across renders.
 */
export function useAutoHide(delayMs: number) {
  const [visible, setVisible] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const reveal = useCallback(() => {
    setVisible(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setVisible(false), delayMs);
  }, [delayMs]);

  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setVisible(false);
  }, []);

  useEffect(() => {
    reveal();
    return () => clearTimeout(timer.current);
  }, [reveal]);

  return { visible, reveal, hide };
}
