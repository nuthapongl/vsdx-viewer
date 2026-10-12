import type { DiagramPage } from "../model/types";

interface Props {
  pages: DiagramPage[];
  index: number;
  onSelect: (index: number) => void;
}

export function PageSelector({ pages, index, onSelect }: Props) {
  return (
    <div className="pages" role="tablist" aria-label="Pages">
      {pages.map((p, i) => (
        <button
          key={p.id}
          role="tab"
          aria-selected={i === index}
          className={i === index ? "active" : undefined}
          onClick={() => onSelect(i)}
        >
          {p.name}
        </button>
      ))}
    </div>
  );
}
