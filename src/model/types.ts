/**
 * Internal diagram model.
 *
 * This is the only contract between the VSDX parser and the SVG renderer.
 * It knows nothing about Visio: coordinates are CSS pixels, the origin is the
 * top-left corner of the page and the Y axis points down.
 */

export interface DiagramDocument {
  name: string;
  pages: DiagramPage[];
  /** Non-fatal problems met while parsing (unsupported parts, broken shapes...). */
  warnings?: string[];
  /** Releases resources (image Blob URLs) held by the document. Call when it is replaced. */
  dispose?: () => void;
}

export interface DiagramPage {
  id: string;
  name: string;
  /** Page size in px. */
  width: number;
  height: number;
  /** Shapes in paint order (first = bottom). Groups are flattened, see `parentId`. */
  shapes: DiagramShape[];
}

export type ShapeType =
  | "rectangle"
  | "ellipse"
  | "line"
  | "connector"
  | "text"
  | "group"
  | "image"
  | "unknown";

export interface DiagramShape {
  id: string;
  /** Id of the containing group shape (same page), if any. */
  parentId?: string;
  name?: string;
  type: ShapeType;

  /**
   * Unrotated frame of the shape in page coordinates. `rotation` and `flipX`
   * are applied around the frame centre.
   */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees, clockwise on screen. */
  rotation: number;
  /** Mirror the shape horizontally (applied before rotation). */
  flipX: boolean;

  text?: string;
  /** Text split into formatting runs (font, size, colour... per run), in reading order. */
  textRuns?: TextRun[];
  /** Block-level text settings (alignment, margins) plus the first run's character style. */
  textStyle?: TextStyle;
  /** Text block rectangle in the shape's local frame (px, top-left origin). */
  textBlock?: TextBlock;

  style: ShapeStyle;

  /**
   * Outline paths in the shape's local frame: origin = frame top-left, Y down,
   * units px. Empty for shapes that only carry text or an image.
   */
  geometry: GeometryPath[];

  /** Present for 1-D shapes (connectors / lines). Page coordinates. */
  connector?: ConnectorInfo;

  image?: ImageData;

  /**
   * For a line: the nodes the user confirmed each end connects to (shape ids), kept in the file.
   * Used by the diagram analysis when the geometry alone doesn't say.
   */
  links?: { begin?: string[]; end?: string[] };
  /**
   * For a node: the high-availability group the user put it in (kept in the file). Nodes with
   * the same number can stand in for one another.
   */
  ha?: number;

  /** Source information, kept for debugging and later round-tripping. */
  source?: { master?: string; masterId?: string };
}

export interface ShapeStyle {
  /** CSS colour, or undefined for no fill. */
  fill?: string;
  /** Replaces `fill` when present (a themed shape's gradient). Angle in degrees, 90 = top to bottom. */
  gradient?: { angle: number; stops: { offset: number; color: string }[] };
  /** Drop shadow (px), drawn behind the shape's filled paths. */
  shadow?: { dx: number; dy: number; blur: number; opacity: number };
  fillOpacity?: number;
  /** CSS colour, or undefined for no stroke. */
  stroke?: string;
  strokeWidth: number;
  strokeOpacity?: number;
  /** SVG stroke-dasharray, expressed in multiples of the stroke width. */
  dash?: number[];
  /** Arrow head ids (0/undefined = none). Only meaningful for open paths. */
  beginArrow?: number;
  endArrow?: number;
  /** Arrow size index 0 (very small) .. 6 (colossal); 2 = medium, the default. */
  beginArrowSize?: number;
  endArrowSize?: number;
  /** Corner radius for rectangles in px. */
  rounding?: number;
}

export interface TextStyle {
  /** px */
  fontSize: number;
  fontFamily?: string;
  color: string;
  /** Colour painted behind the words (a connector's label), when the shape has one. */
  background?: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: "left" | "center" | "right";
  verticalAlign: "top" | "middle" | "bottom";
  /** px */
  margins: { top: number; right: number; bottom: number; left: number };
}

/** A stretch of text with uniform character formatting. May contain "\n" line breaks. */
export interface TextRun {
  text: string;
  /** px */
  fontSize: number;
  /** CSS font-family list, built from the file's font names. */
  fontFamily: string;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** Alignment of the paragraph this run belongs to. */
  align: "left" | "center" | "right";
}

export interface TextBlock {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees, clockwise, around the block centre (additional to shape rotation). */
  angle: number;
}

export type PathCommand =
  | { op: "M"; x: number; y: number }
  | { op: "L"; x: number; y: number }
  | { op: "Q"; x1: number; y1: number; x: number; y: number }
  | {
      op: "C";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      x: number;
      y: number;
    }
  | {
      op: "A";
      rx: number;
      ry: number;
      /** Degrees, SVG convention. */
      rotation: number;
      largeArc: boolean;
      sweep: boolean;
      x: number;
      y: number;
    }
  | { op: "Z" };

export interface GeometryPath {
  commands: PathCommand[];
  fill: boolean;
  stroke: boolean;
}

export interface Point {
  x: number;
  y: number;
}

export interface ConnectorEnd {
  point: Point;
  /** Id of the shape this end is glued to, when known. */
  shapeId?: string;
}

/** A side of a shape, as seen on the page. */
export type Side = "N" | "E" | "S" | "W";

export interface ConnectorRoute {
  /** `elbow` runs in right angles and is re-routed around other shapes; `straight` is a single segment. */
  style: "straight" | "elbow";
  /** Sides of the glued shapes the connector leaves through / enters by (when known). */
  beginSide?: Side;
  endSide?: Side;
}

export interface ConnectorInfo {
  begin: ConnectorEnd;
  end: ConnectorEnd;
  route?: ConnectorRoute;
}

export interface ImageData {
  /** URL (blob: or data:) ready for <image href>. Absent when the format can't be shown in a browser (EMF, WMF...). */
  href?: string;
  format: string;
  /**
   * Where the picture sits in the shape's local frame (px, top-left origin). It may be
   * larger than the shape or offset from it; whatever sticks out is cropped by the shape's frame.
   */
  x: number;
  y: number;
  width: number;
  height: number;
}
