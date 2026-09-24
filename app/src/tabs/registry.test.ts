import { TABS } from './registry';

describe('TABS', () => {
  it('lists Printer Cam, Elegoo, then Settings, in that order', () => {
    expect(TABS.map((tab) => tab.id)).toEqual(['printer-cam', 'elegoo', 'settings']);
  });

  it('gives the Elegoo tab a short label for the tab strip', () => {
    const elegoo = TABS.find((tab) => tab.id === 'elegoo');
    expect(elegoo?.title).toBe('Elegoo');
  });

  it('gives every tab a component to render', () => {
    for (const tab of TABS) {
      expect(tab.Component).toBeTruthy();
    }
  });
});
