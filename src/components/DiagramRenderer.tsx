import { memo } from "react";
import type { DiagramPage, DiagramShape, GeometryPath, PathCommand } from "../model/types";
import { applyMatrix, placementMatrix } from "../model/transform";
import { arrowHead } from "../render/arrow";
import { n, shapeTransform } from "../render/shapeTransform";
import { layoutRuns, lineHeightOf } from "../render/textLayout";

function pathData(cmds: PathCommand[]): string {
  return cmds
    .map((c) => {
      switch (c.op) {
        case "M":
        case "L":
          return `${c.op}${n(c.x)} ${n(c.y)}`;
        case "Q":
          return `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`;
        case "C":
          return `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`;
        case "A":
          return `A${n(c.rx)} ${n(c.ry)} ${n(c.rotation)} ${c.largeArc ? 1 : 0} ${c.sweep ? 1 : 0} ${n(c.x)} ${n(c.y)}`;
        case "Z":
          return "Z";
      }
    })
    .join("");
}

function ArrowMarker({ id, head }: { id: string; head: { length: number; width: number } }) {
  // The tip is at the end of the path; markers are sized in the shape's own px.
  return (
    <marker
      id={id}
      viewBox="0 0 10 7.3"
      refX="10"
      refY="3.65"
      markerUnits="userSpaceOnUse"
      markerWidth={n(head.length)}
      markerHeight={n(head.width)}
      orient="auto-start-reverse"
    >
      <path d="M0 0L10 3.65L0 7.3z" fill="context-stroke" />
    </marker>
  );
}

/** A gradient across the shape's box, at the angle the theme gives (90 = top to bottom). */
function Gradient({ id, gradient }: { id: string; gradient: NonNullable<DiagramShape["style"]["gradient"]> }) {
  const a = (gradient.angle * Math.PI) / 180;
  const [dx, dy] = [Math.cos(a) / 2, Math.sin(a) / 2];
  return (
    <linearGradient id={id} x1={0.5 - dx} y1={0.5 - dy} x2={0.5 + dx} y2={0.5 + dy}>
      {gradient.stops.map((s, i) => (
        <stop key={i} offset={s.offset} stopColor={s.color} />
      ))}
    </linearGradient>
  );
}

function PathView({ shape, path, index }: { shape: DiagramShape; path: GeometryPath; index: number }) {
  const st = shape.style;
  const gradId = st.gradient && path.fill ? `gr-${shape.id}-${index}` : undefined;
  const shadowId = st.shadow && path.fill && st.fill ? `sh-${shape.id}-${index}` : undefined;
  const closed = path.commands.some((c) => c.op === "Z");
  const stroke = path.stroke ? st.stroke : undefined;
  // Marker orientation follows the path direction, which is what Visio does.
  const arrows = !closed && stroke !== undefined;
  const beginId = arrows && st.beginArrow ? `ah-${shape.id}-${index}-b` : undefined;
  const endId = arrows && st.endArrow ? `ah-${shape.id}-${index}-e` : undefined;
  return (
    <>
      {shadowId && st.shadow && (
        <filter id={shadowId} x="-20%" y="-20%" width="140%" height="150%" colorInterpolationFilters="sRGB">
          <feDropShadow
            dx={n(st.shadow.dx)}
            dy={n(st.shadow.dy)}
            stdDeviation={n(st.shadow.blur / 2)}
            floodColor="#000"
            floodOpacity={st.shadow.opacity}
          />
        </filter>
      )}
      {gradId && st.gradient && <Gradient id={gradId} gradient={st.gradient} />}
      {beginId && <ArrowMarker id={beginId} head={arrowHead(st.strokeWidth, st.beginArrowSize)} />}
      {endId && <ArrowMarker id={endId} head={arrowHead(st.strokeWidth, st.endArrowSize)} />}
      <path
        d={pathData(path.commands)}
        fill={gradId ? `url(#${gradId})` : path.fill && st.fill ? st.fill : "none"}
        fillOpacity={st.fillOpacity}
        stroke={stroke ?? "none"}
        strokeOpacity={st.strokeOpacity}
        strokeWidth={st.strokeWidth}
        strokeDasharray={st.dash ? st.dash.map((d) => n(d * st.strokeWidth)).join(" ") : undefined}
        strokeLinejoin="round"
        filter={shadowId ? `url(#${shadowId})` : undefined}
        markerStart={beginId ? `url(#${beginId})` : undefined}
        markerEnd={endId ? `url(#${endId})` : undefined}
      />
    </>
  );
}

function ShapeText({ shape }: { shape: DiagramShape }) {
  const { textRuns: runs, textStyle: ts, textBlock: tb } = shape;
  if (!runs?.length || !ts || !tb) return null;

  // Text is positioned through the (possibly mirrored) shape frame but is never mirrored itself.
  const [cx, cy] = applyMatrix(placementMatrix(shape), tb.x + tb.width / 2, tb.y + tb.height / 2);
  const angle = shape.rotation + (shape.flipX ? -tb.angle : tb.angle);

  const innerW = Math.max(tb.width - ts.margins.left - ts.margins.right, 0);
  const lines = layoutRuns(runs, innerW);
  const heights = lines.map(lineHeightOf);
  const blockH = heights.reduce((a, b) => a + b, 0);
  const innerTop = -tb.height / 2 + ts.margins.top;
  const innerH = tb.height - ts.margins.top - ts.margins.bottom;
  const firstTop =
    ts.verticalAlign === "top"
      ? innerTop
      : ts.verticalAlign === "bottom"
        ? innerTop + innerH - blockH
        : innerTop + (innerH - blockH) / 2;
  // Top edge of each line, accumulated from the block's first line.
  const tops = heights.map((_, i) => firstTop + heights.slice(0, i).reduce((a, b) => a + b, 0));

  return (
    <g
      data-shape-id={shape.id}
      transform={`translate(${n(cx)} ${n(cy)}) rotate(${n(angle)})`}
      pointerEvents="none"
    >
      {/* Clicking the words selects the shape even when its box has no fill. */}
      {ts.background &&
        lines.map((line, i) => {
          if (line.width <= 0) return null;
          const left =
            line.align === "left"
              ? -tb.width / 2 + ts.margins.left
              : line.align === "right"
                ? tb.width / 2 - ts.margins.right - line.width
                : (ts.margins.left - ts.margins.right) / 2 - line.width / 2;
          return (
            <rect
              key={`bk${i}`}
              x={n(left - 2)}
              y={n(tops[i])}
              width={n(line.width + 4)}
              height={n(heights[i])}
              fill={ts.background}
            />
          );
        })}
      {lines.map((line, i) => {
        const left =
          line.align === "left"
            ? -tb.width / 2 + ts.margins.left
            : line.align === "right"
              ? tb.width / 2 - ts.margins.right - line.width
              : (ts.margins.left - ts.margins.right) / 2 - line.width / 2;
        return line.width > 0 ? (
          <rect
            key={`hit${i}`}
            x={n(left)}
            y={n(tops[i])}
            width={n(line.width)}
            height={n(heights[i])}
            fill="transparent"
            pointerEvents="all"
          />
        ) : null;
      })}
      {lines.map((line, i) => {
        const x =
          line.align === "left"
            ? -tb.width / 2 + ts.margins.left
            : line.align === "right"
              ? tb.width / 2 - ts.margins.right
              : (ts.margins.left - ts.margins.right) / 2;
        const baseline = tops[i] + line.fontSize * 0.95 + (heights[i] - line.fontSize * 1.2) / 2;
        return (
          <text
            key={i}
            x={n(x)}
            y={n(baseline)}
            textAnchor={line.align === "left" ? "start" : line.align === "right" ? "end" : "middle"}
            xmlSpace="preserve"
          >
            {line.segments.map((seg, j) => (
              <tspan
                key={j}
                fill={seg.run.color}
                fontFamily={seg.run.fontFamily}
                fontSize={seg.run.fontSize}
                fontWeight={seg.run.bold ? 700 : undefined}
                fontStyle={seg.run.italic ? "italic" : undefined}
                textDecoration={seg.run.underline ? "underline" : undefined}
              >
                {seg.text}
              </tspan>
            ))}
          </text>
        );
      })}
    </g>
  );
}

function ImageView({ shape }: { shape: DiagramShape }) {
  const img = shape.image;
  if (!img) return null;
  if (img.href) {
    // The picture may be larger than the shape or offset from it: the shape's frame crops it.
    const sticksOut =
      img.x < -0.01 ||
      img.y < -0.01 ||
      img.x + img.width > shape.width + 0.01 ||
      img.y + img.height > shape.height + 0.01;
    const clip = `clip-${shape.id}`;
    return (
      <>
        {sticksOut && (
          <clipPath id={clip}>
            <rect width={shape.width} height={shape.height} />
          </clipPath>
        )}
        <image
          href={img.href}
          x={img.x}
          y={img.y}
          width={img.width}
          height={img.height}
          preserveAspectRatio="none"
          clipPath={sticksOut ? `url(#${clip})` : undefined}
        />
      </>
    );
  }
  // EMF/WMF/etc. can't be shown by browsers: mark where the picture should be.
  return (
    <g>
      <rect
        width={shape.width}
        height={shape.height}
        fill="#f1f1f1"
        stroke="#9a9a9a"
        strokeDasharray="4 3"
      />
      <text
        x={shape.width / 2}
        y={shape.height / 2}
        textAnchor="middle"
        fontSize={11}
        fill="#777"
        fontFamily="sans-serif"
      >
        {`unsupported image${img.format ? ` (${img.format})` : ""}`}
      </text>
    </g>
  );
}

/** Pixels (on screen, whatever the zoom) within which a click counts as hitting a line. */
const HIT_STROKE = 10;

const ShapeView = memo(function ShapeView({ shape }: { shape: DiagramShape }) {
  const hitRect = shape.type === "text" && shape.width > 0 && shape.height > 0;
  return (
    <>
      <g data-shape-id={shape.id} transform={shapeTransform(shape)}>
        {shape.geometry.map((p, i) => (
          <PathView key={i} shape={shape} path={p} index={i} />
        ))}
        <ImageView shape={shape} />
        {hitRect && <rect width={shape.width} height={shape.height} fill="transparent" />}
        {/* Unfilled outlines are only hit on their line; make that line easy to grab. */}
        {shape.geometry.map((p, i) =>
          p.stroke && shape.style.stroke && !(p.fill && shape.style.fill) ? (
            <path
              key={`hit${i}`}
              d={pathData(p.commands)}
              fill="none"
              stroke="transparent"
              strokeWidth={HIT_STROKE}
              vectorEffect="non-scaling-stroke"
              pointerEvents="stroke"
            />
          ) : null,
        )}
      </g>
      <ShapeText shape={shape} />
    </>
  );
});

/**
 * Draws a page of the internal diagram model as SVG, in page px coordinates.
 * It must be rendered inside an <svg>; it knows nothing about Visio.
 */
export const DiagramRenderer = memo(function DiagramRenderer({ page }: { page: DiagramPage }) {
  return (
    <g data-page={page.id}>
      {page.shapes.map((s) => (
        <ShapeView key={s.id} shape={s} />
      ))}
    </g>
  );
});
