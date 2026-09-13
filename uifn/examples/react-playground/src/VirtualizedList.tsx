import type { ReactNode } from "react";

type VirtualizedListProps<T> = {
  items: T[];
  itemHeight: number;
  height: number;
  className?: string;
  "aria-label"?: string;
  renderItem: (item: T, index: number) => ReactNode;
};

export function VirtualizedList<T>({
  items,
  itemHeight,
  height,
  className,
  "aria-label": ariaLabel,
  renderItem,
}: VirtualizedListProps<T>) {
  return (
    <div
      className={className}
      style={{ height, overflow: "auto" }}
      aria-label={ariaLabel}
    >
      {items.map((item, index) => (
        <div key={index} style={{ minHeight: itemHeight }}>
          {renderItem(item, index)}
        </div>
      ))}
    </div>
  );
}
