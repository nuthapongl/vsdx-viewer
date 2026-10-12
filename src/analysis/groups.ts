/**
 * High-availability groups: nodes that stand in for one another (the two application servers
 * of two data centres, the primary and secondary database, a pair of load balancers).
 * The user's groups are kept on the node shapes (`DiagramShape.ha`); the app only suggests.
 */
import type { DiagramShape } from "../model/types";
import type { AnalysisNode } from "./nodes";

export interface HaGroup {
  /** The number stored in the file. */
  number: number;
  members: string[];
}

export interface HaGroups {
  groups: HaGroup[];
  /** Node id -> id of its group, for the nodes that are in one with a stand-in. */
  groupOf: Map<string, string>;
}

export const groupKey = (n: number) => `ha:${n}`;

/** The groups the user made, read from the node shapes. A group of one member does nothing. */
export function readGroups(nodes: Map<string, AnalysisNode>, shapes: Map<string, DiagramShape>): HaGroups {
  const byNumber = new Map<number, string[]>();
  for (const id of nodes.keys()) {
    const n = shapes.get(id)?.ha;
    if (n !== undefined) byNumber.set(n, [...(byNumber.get(n) ?? []), id]);
  }
  const groups = [...byNumber.entries()]
    .map(([number, members]) => ({ number, members }))
    .sort((a, b) => a.number - b.number);
  const groupOf = new Map<string, string>();
  for (const g of groups) if (g.members.length > 1) for (const m of g.members) groupOf.set(m, groupKey(g.number));
  return { groups, groupOf };
}

/** What makes two nodes "the same service": the name without numbers, addresses and notes in brackets. */
export function serviceKey(n: AnalysisNode): string {
  return n.title
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, " ")
    .replace(/:\s*\d+/g, " ")
    .replace(/[^a-z\u0e00-\u0e7f]+/g, " ")
    .trim();
}

export interface Suggestion {
  /** The shared name, for display. */
  name: string;
  members: string[];
}

/** Nodes with the same service name that are not in a group yet: probably stand-ins for each other. */
export function suggestGroups(nodes: Map<string, AnalysisNode>, taken: Set<string>): Suggestion[] {
  const byKey = new Map<string, AnalysisNode[]>();
  for (const n of nodes.values()) {
    if (taken.has(n.id)) continue;
    const k = serviceKey(n);
    if (k.length >= 2) byKey.set(k, [...(byKey.get(k) ?? []), n]);
  }
  return [...byKey.values()]
    .filter((list) => list.length > 1)
    .map((list) => ({ name: list[0].title.replace(/\s*\([^)]*\)\s*$/, ""), members: list.map((n) => n.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
