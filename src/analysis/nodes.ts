/**
 * Finding the "machines" on a diagram, and what the labels say about them.
 *
 * A node is a top-level tile: a group, or a shape with text. Its name, IP
 * addresses, host names and ports are read from the label, which is free text
 * ("w2dbspho1c2los 172.20.22.111 :1433, 1434"). IP addresses written on a VIP
 * line are ignored: they identify a virtual address shared by several nodes,
 * not a machine. Several IPs in one node are several interfaces of one machine.
 */
import { frameCorners, insideFrame, lineVertices, mostlyInside, subtreeIds } from "../edit/connectors";
import { rectOf } from "../edit/routing";
import type { DiagramShape } from "../model/types";

export interface AnalysisNode {
  /** Id of the top-level shape that draws the node. */
  id: string;
  /** First line of the label, e.g. "DB2 Server (Primary)". */
  title: string;
  hostnames: string[];
  /** Non-VIP IPv4 addresses (interfaces of this one machine). */
  ips: string[];
  ports: string[];
  /** All of the label's text. */
  text: string;
  /** Ids of the zone frames this node lies in. */
  zones: string[];
  /** Colour of the label text: a hint of which site/line style it belongs to. */
  colour?: string;
}

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const VALID_IP = (ip: string) => ip.split(".").every((o) => Number(o) <= 255);
const DOTTED_NAME = /\b(?!(?:\d{1,3}\.){3}\d{1,3}\b)[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+\b/gi;
const MIXED_NAME = /\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{7,}\b/gi;
const PORTS = /:\s*(\d{2,5}(?:\s*,\s*\d{2,5})*)/g;

/** An outline that only marks an area (no fill, text or picture): a zone or a container. */
export const isFrame = (s: DiagramShape) =>
  s.type !== "group" && !s.style.fill && !s.text && !s.image && s.width > 0 && s.height > 0;

export interface Label {
  title: string;
  hostnames: string[];
  ips: string[];
  ports: string[];
}

/** Read names, addresses and ports out of a label. VIP lines do not identify the machine. */
export function parseLabel(text: string): Label {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const ips = new Set<string>();
  const hostnames = new Set<string>();
  const ports = new Set<string>();
  for (const rawLine of lines) {
    // A URL names the machine the text points at, not the machine drawn: leave it out.
    const line = rawLine.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, " ");
    const vip = /\bVIP\b/i.test(line);
    for (const ip of line.match(IPV4) ?? []) if (!vip && VALID_IP(ip)) ips.add(ip);
    for (const h of [...(line.match(DOTTED_NAME) ?? []), ...(line.match(MIXED_NAME) ?? [])]) {
      hostnames.add(h.toLowerCase());
    }
    for (const m of line.matchAll(PORTS)) for (const p of m[1].split(",")) ports.add(p.trim());
  }
  // The title is the first line that says something: not just a port or an address.
  const words = (l: string) => (l.replace(/\([^)]*\)/g, " ").replace(/:\s*\d+/g, " ").match(/[a-z]/gi) ?? []).length;
  const title = lines.find((l) => words(l) >= 3) ?? lines[0] ?? "";
  return { title, hostnames: [...hostnames], ips: [...ips], ports: [...ports] };
}

/** Text of a shape and of everything drawn inside it, in paint order. */
function textOfSubtree(shapes: DiagramShape[], id: string): DiagramShape[] {
  const inside = subtreeIds(shapes, id);
  return shapes.filter((s) => inside.has(s.id) && s.text && s.text.trim());
}

export interface Candidates {
  nodes: AnalysisNode[];
  /** Frames that mark areas (zones), which contain nodes but are not nodes. */
  zones: DiagramShape[];
  /** Name of each zone, read from the title label near one of its corners ("LOS DC1"). */
  zoneNames: Map<string, string>;
  /**
   * Shapes that belong to a node although they are drawn on their own: small labels laid over a
   * tile ("HA (Active - Active)" on a balancer's box) and icons standing right beside a label (the
   * F5 logo next to a text-only balancer). Lines that end on them end on the node.
   * Label/icon shape id -> the node they belong to.
   */
  labels: Map<string, string>;
}

/**
 * Candidate nodes on a page. Whether a shape is kept as a node depends also on
 * what is connected to it, which `buildTopology` decides.
 */
export function extractCandidates(shapes: DiagramShape[]): Candidates {
  const top = shapes.filter(
    (s) => !s.parentId && !s.connector && !lineVertices(s) && s.width > 0 && s.height > 0 && !s.id.startsWith("bg"),
  );
  const zones = top.filter(isFrame);
  const zoneSet = new Set(zones.map((z) => z.id));

  const nodes: AnalysisNode[] = [];
  for (const s of top) {
    if (zoneSet.has(s.id)) continue;
    const texts = textOfSubtree(shapes, s.id);
    if (s.type !== "group" && texts.length === 0) continue;
    const text = texts.map((t) => t.text!).join("\n");
    if (!text.trim()) continue;

    // The label that carries the details is the one with addresses, else the longest.
    const main =
      texts.find((t) => (t.text!.match(IPV4) ?? []).length > 0) ??
      [...texts].sort((a, b) => b.text!.length - a.text!.length)[0];
    const label = parseLabel(texts.map((t) => t.text!).join("\n"));
    const title = parseLabel(main.text!).title || label.title;

    nodes.push({
      id: s.id,
      title,
      hostnames: label.hostnames,
      ips: label.ips,
      ports: label.ports,
      text,
      zones: zones.filter((z) => mostlyInside(z, frameCorners(s))).map((z) => z.id),
      colour: main.textRuns?.[0]?.color,
    });
  }

  // A label that names no machine and lies on a bigger tile is part of that tile.
  const byId = new Map(top.map((s) => [s.id, s]));
  const labels = new Map<string, string>();
  const named = (n: AnalysisNode) => n.ips.length > 0 || n.hostnames.length > 0;
  for (const n of nodes) {
    const shape = byId.get(n.id)!;
    if (named(n) || shape.type === "group") continue;
    const host = nodes
      .filter((h) => h.id !== n.id && !labels.has(h.id))
      .map((h) => byId.get(h.id)!)
      .filter((h) => h.width * h.height > shape.width * shape.height && mostlyInside(h, frameCorners(shape)))
      .sort((a, b) => a.width * a.height - b.width * b.height)[0];
    if (host) labels.set(n.id, host.id);
  }
  const hosts = new Map(nodes.map((n) => [n.id, n]));
  for (const [labelId, hostId] of labels) {
    const label = hosts.get(labelId);
    if (label) hosts.get(hostId)!.text += `\n${label.text}`;
  }
  // A bare text box that names no machine and sits on no tile is a note beside a line (":443",
  // "RHA Engine :25000"), not a machine: lines that touch it really end at what is behind it.
  const invisible = (s: DiagramShape) => s.type !== "group" && !s.image && !s.style.fill && !s.style.stroke;
  // An icon (a picture with no text) standing right next to a node is that node's icon.
  const ICON_GAP = 24;
  const gap = (a: DiagramShape, b: DiagramShape) => {
    const [r, q] = [rectOf(a), rectOf(b)];
    const dx = Math.max(0, r.x - (q.x + q.width), q.x - (r.x + r.width));
    const dy = Math.max(0, r.y - (q.y + q.height), q.y - (r.y + r.height));
    return Math.hypot(dx, dy);
  };
  for (const s of top) {
    if (!s.image || s.text || s.width * s.height > 12000 || labels.has(s.id)) continue;
    const host = nodes
      .filter((n) => !labels.has(n.id))
      .map((n) => ({ n, g: gap(s, byId.get(n.id)!) }))
      .filter((x) => x.g <= ICON_GAP)
      .sort((a, b) => a.g - b.g)[0];
    if (host) labels.set(s.id, host.n.id);
  }

  const note = (n: AnalysisNode) => !named(n) && invisible(byId.get(n.id)!) && !labels.has(n.id);

  // A zone is named by a short, plain title lying inside it near a corner ("LOS DC1" top left,
  // "Internal Server-DC1" bottom left).
  const zoneNames = new Map<string, string>();
  // Captions inside a tile ("Send SMS" under the SMS Gateway) belong to that tile, not to the zone.
  const nodeFrames = nodes.map((n) => byId.get(n.id)!);
  const insideATile = (s: DiagramShape) =>
    nodeFrames.some((f) => f.id !== s.id && insideFrame(f, { x: s.x + s.width / 2, y: s.y + s.height / 2 }));
  for (const z of zones) {
    const reach = 0.35 * Math.max(z.width, z.height);
    const corners = frameCorners(z);
    const title = top
      .filter((s) => !zoneSet.has(s.id) && s.type !== "group" && s.text && !insideATile(s) && mostlyInside(z, frameCorners(s)))
      .map((s) => ({ s, label: parseLabel(s.text!) }))
      .filter(
        ({ s, label }) =>
          !s.text!.includes("\n") &&
          s.text!.trim().length <= 30 &&
          (s.text!.match(/[a-z]/gi) ?? []).length >= 3 &&
          label.ips.length === 0 &&
          label.hostnames.length === 0 &&
          !/^[\s:\d,]+$/.test(s.text!),
      )
      .map(({ s }) => {
        const c = { x: s.x + s.width / 2, y: s.y + s.height / 2 };
        return { s, d: Math.min(...corners.map((k) => Math.hypot(k.x - c.x, k.y - c.y))) };
      })
      .filter((x) => x.d <= reach)
      .sort((a, b) => a.d - b.d)[0];
    if (title) zoneNames.set(z.id, title.s.text!.trim());
  }

  return { nodes: nodes.filter((n) => !labels.has(n.id) && !note(n)), zones, zoneNames, labels };
}
