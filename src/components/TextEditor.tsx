import { useEffect, useRef, useState } from "react";
import type { DiagramShape } from "../model/types";
import { applyMatrix, placementMatrix } from "../model/transform";

interface Props {
  shape: DiagramShape;
  view: { scale: number; tx: number; ty: number };
  onCommit: (text: string) => void;
  onCancel: () => void;
}

/** In-place text editor: a textarea laid over the shape's text block. */
export function TextEditor({ shape, view, onCommit, onCancel }: Props) {
  const [value, setValue] = useState(shape.text ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const tb = shape.textBlock ?? { x: 0, y: 0, width: shape.width, height: shape.height, angle: 0 };
  const run = shape.textRuns?.[0];
  const [cx, cy] = applyMatrix(placementMatrix(shape), tb.x + tb.width / 2, tb.y + tb.height / 2);
  const angle = shape.rotation + (shape.flipX ? -tb.angle : tb.angle);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit && value !== (shape.text ?? "")) onCommit(value);
    else onCancel();
  };

  return (
    <textarea
      ref={ref}
      className="text-editor"
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") finish(false);
        else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) finish(true);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        left: cx * view.scale + view.tx,
        top: cy * view.scale + view.ty,
        width: Math.max(tb.width * view.scale, 120),
        minHeight: Math.max(tb.height * view.scale, 28),
        transform: `translate(-50%, -50%) rotate(${angle}deg)`,
        fontFamily: run?.fontFamily,
        fontSize: Math.max((run?.fontSize ?? 16) * view.scale, 12),
        fontWeight: run?.bold ? 700 : undefined,
        fontStyle: run?.italic ? "italic" : undefined,
        color: run?.color,
        textAlign: run?.align ?? "center",
      }}
    />
  );
}
