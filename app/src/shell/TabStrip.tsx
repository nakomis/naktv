import type { TabDefinition } from '../tabs/registry';

interface TabStripProps {
  tabs: readonly TabDefinition[];
  activeIndex: number;
  visible: boolean;
  onSelect: (index: number) => void;
}

export function TabStrip({ tabs, activeIndex, visible, onSelect }: TabStripProps) {
  return (
    <nav className={visible ? 'tab-strip' : 'tab-strip hidden'} aria-hidden={!visible}>
      <span className="brand">NakTV</span>
      <div role="tablist" aria-label="NakTV">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            type="button"
            role="tab"
            className="tab"
            aria-selected={index === activeIndex}
            aria-controls={`panel-${tab.id}`}
            tabIndex={-1}
            onClick={() => onSelect(index)}
          >
            {tab.title}
          </button>
        ))}
      </div>
    </nav>
  );
}
