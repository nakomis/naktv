import { useCallback, useEffect, useState } from 'react';
import { CONFIG } from '../config';
import { isBack, Keys } from '../keys';
import { TABS, type TabDefinition } from '../tabs/registry';
import { TabStrip } from './TabStrip';
import { useAutoHide } from './useAutoHide';

interface AppProps {
  tabs?: readonly TabDefinition[];
  /** Injected for tests; closes the webOS app otherwise. */
  onExit?: () => void;
}

/**
 * Remote-control model: the strip starts visible and fades after a few
 * seconds. While hidden, a keypress only brings it back (so a stray press
 * never changes tab unseen); while visible, Left/Right move between tabs and
 * Down dismisses it. Back always exits.
 */
export function App({ tabs = TABS, onExit = () => window.close() }: AppProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const strip = useAutoHide(CONFIG.stripHideDelayMs);

  const select = useCallback(
    (index: number) => {
      setActiveIndex(Math.max(0, Math.min(tabs.length - 1, index)));
      strip.reveal();
    },
    [tabs.length, strip.reveal],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isBack(event.keyCode)) {
        event.preventDefault();
        onExit();
        return;
      }
      if (!strip.visible) {
        if (event.keyCode !== Keys.Down) strip.reveal();
        return;
      }
      switch (event.keyCode) {
        case Keys.Left:
          select(activeIndex - 1);
          break;
        case Keys.Right:
          select(activeIndex + 1);
          break;
        case Keys.Down:
          strip.hide();
          break;
        default:
          strip.reveal();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [activeIndex, select, strip.visible, strip.reveal, strip.hide, onExit]);

  // Pressing the NakTV button while the app is already running doesn't
  // reload it — webOS fires webOSRelaunch instead. Treat it as "show me".
  // Moving the Magic Remote pointer counts as a keypress too.
  useEffect(() => {
    const reveal = () => strip.reveal();
    document.addEventListener('webOSRelaunch', reveal);
    document.addEventListener('mousemove', reveal);
    return () => {
      document.removeEventListener('webOSRelaunch', reveal);
      document.removeEventListener('mousemove', reveal);
    };
  }, [strip.reveal]);

  const active = tabs[activeIndex];
  return (
    <div className="shell">
      <TabStrip tabs={tabs} activeIndex={activeIndex} visible={strip.visible} onSelect={select} />
      {active && (
        <main
          key={active.id}
          id={`panel-${active.id}`}
          className="tab-panel"
          role="tabpanel"
          aria-labelledby={`tab-${active.id}`}
        >
          <active.Component />
        </main>
      )}
    </div>
  );
}
