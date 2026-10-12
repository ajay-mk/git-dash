import { useId } from 'react';

/** A titled section whose body can be collapsed from its header. */
export function Collapsible({ title, count, collapsed, onToggle, badge, controls, className, children }: {
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  /** Shown next to the title, even while collapsed. */
  badge?: React.ReactNode;
  /** Shown at the end of the header while expanded. */
  controls?: React.ReactNode;
  className: string;
  children: React.ReactNode;
}) {
  const bodyId = useId();
  return (
    <section className={className}>
      <div className="section-header">
        <h3 className="widget-title">
          <button
            type="button"
            className="section-toggle"
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            onClick={onToggle}
          >
            <span className="chevron" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
            {title} <span className="count">{count}</span>
          </button>
          {badge}
        </h3>
        {!collapsed && controls}
      </div>
      <div id={bodyId} hidden={collapsed}>
        {!collapsed && children}
      </div>
    </section>
  );
}
