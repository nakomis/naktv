import type { ComponentType } from 'react';
import { ElegooCam } from './elegoo/ElegooCam';
import { PrinterCam } from './printer-cam/PrinterCam';
import { SettingsTab } from './settings/Settings';

export interface TabDefinition {
  /** Stable key; also used as the DOM id suffix. */
  id: string;
  /** Label on the tab strip. Keep it short — it is read from the sofa. */
  title: string;
  /**
   * Rendered only while its tab is active, so a tab should start its work on
   * mount and release it (streams, timers) on unmount.
   */
  Component: ComponentType;
}

// To add a tab: write a component under src/tabs/<name>/ and append it here.
export const TABS: readonly TabDefinition[] = [
  { id: 'printer-cam', title: 'Printer Cam', Component: PrinterCam },
  { id: 'elegoo', title: 'Elegoo', Component: ElegooCam },
  { id: 'settings', title: 'Settings', Component: SettingsTab },
];
