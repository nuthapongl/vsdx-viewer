import type { Matrix } from "../model/transform";
import type { Relationship } from "./package";
import type { ShapeSheet } from "./sheet";
import type { ThemeInfo } from "./theme";

/**
 * Parser-internal types: a lightly normalised view of Visio XML that is easy
 * to merge (shape <- master <- style sheet) before it is converted into the
 * renderer-facing diagram model.
 */

export interface Cell {
  /** Value (V attribute). Numbers are kept as strings until needed. */
  v: string;
  /** Formula (F attribute), if any. */
  f?: string;
  /** Unit (U attribute): a label only, `v` is always in internal units. */
  u?: string;
  /** True when the cell came from a master / style rather than the shape. */
  inherited?: boolean;
}

export interface Row {
  /** The row's name (`N` attribute): how user-defined rows are addressed. */
  name?: string;
  type: string;
  ix: string;
  deleted?: boolean;
  cells: Map<string, Cell>;
}

export interface Section {
  name: string;
  ix: string;
  cells: Map<string, Cell>;
  rows: Map<string, Row>;
}

/** Cells and sections of one `<Shape>` element, possibly merged with its master. */
export interface ShapeData {
  cells: Map<string, Cell>;
  /** Keyed by `Name` or `Name#IX` for Geometry sections. */
  sections: Map<string, Section>;
}

export interface StyleSheet {
  id: string;
  lineStyle?: string;
  fillStyle?: string;
  textStyle?: string;
  data: ShapeData;
}

export interface MasterInfo {
  id: string;
  name: string;
  /** Shape elements of the master, including nested ones, keyed by shape ID. */
  allShapes: Map<string, Element>;
  topLevel: Element[];
  /** Relationships of the master part (for embedded images). */
  rels: Map<string, Relationship>;
}

/** Document-wide lookup tables shared by every page. */
export interface DocumentContext {
  styles: Map<string, StyleSheet>;
  /** FaceName ID -> font name. */
  fonts: Map<string, string>;
  masters: Map<string, MasterInfo>;
  theme?: ThemeInfo;
}

export interface PageInfo {
  id: string;
  name: string;
  /** Path of the page part inside the package. */
  path: string;
  background: boolean;
  backPageId?: string;
  width: number;
  height: number;
}

export interface Connect {
  fromSheet: string;
  fromCell: string;
  toSheet: string;
  toCell: string;
}

export interface ParentFrame {
  /** Parent's local frame (Visio inches, Y up) -> page px (Y down). */
  toScreen: Matrix;
  id?: string;
  /** Master that `MasterShape` references of the children point into. */
  master?: MasterInfo;
}

/**
 * Link from a model shape back to the XML it was parsed from, so edits can be
 * written into the original document instead of regenerating it.
 */
export interface ShapeRef {
  el: Element;
  frame: ParentFrame;
  /** Effective (inherited) values as they were when the shape was last parsed. */
  sheet: ShapeSheet;
  /** The master's `<Text>`, used as the starting point when an instance has none. */
  masterText?: Element;
}
