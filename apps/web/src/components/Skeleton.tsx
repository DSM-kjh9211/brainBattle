export function PanelSkeleton({ label }: { label: string }) {
  return <div className="panel-skeleton" role="status" aria-label={`${label} 불러오는 중`}>
    {[0, 1, 2].map((row) => <div className="skeleton-row" key={row} aria-hidden="true"><div className="skeleton-line" /><div className="skeleton-line short" /></div>)}
  </div>;
}
