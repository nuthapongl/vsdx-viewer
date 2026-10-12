/**
 * Builds a small but structurally faithful .vsdx package (OPC/ZIP + Visio XML)
 * that exercises the parser: masters with formulas, style sheets, groups with
 * rotation, flips, connectors with glue, arcs, ellipses, background pages.
 *
 * Used by the unit tests and by `npm run sample` (writes public/sample.vsdx).
 */
import JSZip from "jszip";

const NS = "http://schemas.microsoft.com/office/visio/2012/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.microsoft.com/visio/2010/relationships";

const cell = (n: string, v: string | number, f?: string) =>
  `<Cell N="${n}" V="${v}"${f ? ` F="${f}"` : ""}/>`;

const row = (t: string, ix: number, cells: string) => `<Row T="${t}" IX="${ix}">${cells}</Row>`;
const geom = (ix: number, rows: string, flags = "") =>
  `<Section N="Geometry" IX="${ix}">${flags}${rows}</Section>`;

const rectRows = (w: string, h: string) =>
  row("MoveTo", 1, cell("X", 0) + cell("Y", 0)) +
  row("LineTo", 2, cell("X", w, "Width") + cell("Y", 0)) +
  row("LineTo", 3, cell("X", w, "Width") + cell("Y", h, "Height")) +
  row("LineTo", 4, cell("X", 0) + cell("Y", h, "Height")) +
  row("LineTo", 5, cell("X", 0) + cell("Y", 0));

function xform(pinX: number, pinY: number, w: number, h: number, extra = "") {
  return (
    cell("PinX", pinX) +
    cell("PinY", pinY) +
    cell("Width", w) +
    cell("Height", h) +
    cell("LocPinX", w / 2, "Width*0.5") +
    cell("LocPinY", h / 2, "Height*0.5") +
    extra
  );
}

const text = (s: string) => `<Text>${s}</Text>`;

function shape(
  id: number,
  attrs: string,
  body: string,
  type: "Shape" | "Group" | "Foreign" = "Shape",
  name = `Sheet.${id}`,
) {
  return `<Shape ID="${id}" NameU="${name}" Type="${type}" ${attrs}>${body}</Shape>`;
}

function pageXml(shapes: string, connects = "") {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<PageContents xmlns="${NS}" xmlns:r="${R_NS}"><Shapes>${shapes}</Shapes>` +
    (connects ? `<Connects>${connects}</Connects>` : "") +
    `</PageContents>`
  );
}

export async function buildSampleVsdx(): Promise<Uint8Array> {
  const zip = new JSZip();

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/document" Target="visio/document.xml"/></Relationships>`,
  );

  // --- document.xml: style sheets + fonts ---------------------------------------
  zip.file(
    "visio/document.xml",
    `<?xml version="1.0" encoding="utf-8"?><VisioDocument xmlns="${NS}" xmlns:r="${R_NS}">` +
      `<FaceNames><FaceName ID="0" NameU="Calibri" Name="Calibri"/></FaceNames>` +
      `<StyleSheets>` +
      `<StyleSheet ID="0" NameU="No Style" LineStyle="0" FillStyle="0" TextStyle="0">` +
      cell("LineWeight", 0.01) +
      cell("LineColor", 0) +
      cell("LinePattern", 1) +
      cell("FillForegnd", 1) +
      cell("FillPattern", 1) +
      `<Section N="Character"><Row IX="0">${cell("Font", 0)}${cell("Color", 0)}${cell("Size", 0.1667)}${cell("Style", 0)}</Row></Section>` +
      `<Section N="Paragraph"><Row IX="0">${cell("HorzAlign", 1)}</Row></Section>` +
      `</StyleSheet>` +
      `<StyleSheet ID="1" NameU="Connector" LineStyle="0" FillStyle="0" TextStyle="0">` +
      cell("EndArrow", 4) +
      cell("LineColor", "#404040") +
      cell("LineWeight", 0.02) +
      `</StyleSheet>` +
      `</StyleSheets></VisioDocument>`,
  );
  zip.file(
    "visio/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${REL}/pages" Target="pages/pages.xml"/>` +
      `<Relationship Id="rId2" Type="${REL}/masters" Target="masters/masters.xml"/>` +
      `</Relationships>`,
  );

  // --- masters --------------------------------------------------------------------
  zip.file(
    "visio/masters/masters.xml",
    `<?xml version="1.0" encoding="utf-8"?><Masters xmlns="${NS}" xmlns:r="${R_NS}">` +
      `<Master ID="1" NameU="Process" Name="Process"><Rel r:id="rId1"/></Master></Masters>`,
  );
  zip.file(
    "visio/masters/_rels/masters.xml.rels",
    `<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/master" Target="master1.xml"/></Relationships>`,
  );
  zip.file(
    "visio/masters/master1.xml",
    `<?xml version="1.0" encoding="utf-8"?><MasterContents xmlns="${NS}" xmlns:r="${R_NS}"><Shapes>` +
      shape(
        5,
        `LineStyle="0" FillStyle="0" TextStyle="0"`,
        xform(1, 0.5, 2, 1) +
          cell("FillForegnd", "#9dc3e6") +
          cell("LineColor", "#2f528f") +
          cell("LineWeight", 0.02) +
          geom(0, rectRows("2", "1")),
      ) +
      `</Shapes></MasterContents>`,
  );

  // --- pages index ------------------------------------------------------------------
  zip.file(
    "visio/pages/pages.xml",
    `<?xml version="1.0" encoding="utf-8"?><Pages xmlns="${NS}" xmlns:r="${R_NS}">` +
      `<Page ID="0" NameU="Flowchart" Name="Flowchart" BackPage="2"><PageSheet>${cell("PageWidth", 11)}${cell("PageHeight", 8.5)}</PageSheet><Rel r:id="rId1"/></Page>` +
      `<Page ID="1" NameU="Second" Name="Second page"><PageSheet>${cell("PageWidth", 6)}${cell("PageHeight", 4)}</PageSheet><Rel r:id="rId2"/></Page>` +
      `<Page ID="2" NameU="Background" Name="VBackground-1" Background="1"><PageSheet>${cell("PageWidth", 11)}${cell("PageHeight", 8.5)}</PageSheet><Rel r:id="rId3"/></Page>` +
      `</Pages>`,
  );
  zip.file(
    "visio/pages/_rels/pages.xml.rels",
    `<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${REL}/page" Target="page1.xml"/>` +
      `<Relationship Id="rId2" Type="${REL}/page" Target="page2.xml"/>` +
      `<Relationship Id="rId3" Type="${REL}/page" Target="page3.xml"/>` +
      `</Relationships>`,
  );

  // --- page 1: the "everything" page -------------------------------------------------
  const page1 =
    // 14: a zone box (no fill) that contains shapes 1 and 2 and the connector between them.
    //     First in paint order, so the shapes it contains are drawn on top of it.
    shape(
      14,
      `LineStyle="0" FillStyle="0" TextStyle="0"`,
      xform(4.25, 7.1, 7.5, 2) +
        cell("FillPattern", 0) +
        cell("LineColor", "#c00000") +
        geom(0, rectRows("7.5", "2")),
    ) +
    // 1: master instance, same size as master
    shape(
      1,
      `Master="1" LineStyle="0" FillStyle="0" TextStyle="0"`,
      xform(2, 7, 2, 1) +
        // Two runs: Arial 16px bold, then themed font (-> Calibri via FaceNames 0) 12px italic red.
        `<Section N="Character">` +
        `<Row IX="1">${cell("Font", "Arial")}${cell("Size", 0.1667)}${cell("Style", 1)}</Row>` +
        `<Row IX="2">${cell("Font", 0)}${cell("Size", 0.125)}${cell("Style", 2)}${cell("Color", "#c00000")}</Row>` +
        `</Section>` +
        `<Text><cp IX="1"/>Start<cp IX="2"/> (italic)</Text>`,
      "Shape",
      "Process.1",
    ) +
    // 2: master instance resized -> inherited geometry formulas must follow Width/Height
    shape(
      2,
      `Master="1"`,
      xform(6, 7, 3, 1.5) + text("Resized master"),
      "Shape",
      "Process.2",
    ) +
    // 3: ellipse
    shape(
      3,
      `LineStyle="0" FillStyle="0" TextStyle="0"`,
      xform(2, 4.5, 2, 1.2) +
        cell("FillForegnd", "#ffd966") +
        geom(
          0,
          row("Ellipse", 1, cell("X", 1) + cell("Y", 0.6) + cell("A", 2) + cell("B", 0.6) + cell("C", 1) + cell("D", 1.2)),
        ) +
        `<Section N="Character"><Row IX="0">${cell("Font", "Themed")}${cell("Color", "Themed")}${cell("ComplexScriptFont", "Cordia New")}${cell("Size", 0.15)}</Row></Section>` +
        text("Decision การตัดสินใจ"),
    ) +
    // 4: glued connector (1-D shape) from shape 1 to shape 2, in the form Visio writes it:
    //    end points are constants/glue formulas, Pin/Width/Angle are formulas of them.
    shape(
      4,
      `LineStyle="1" FillStyle="0" TextStyle="0"`,
      cell("PinX", 3.75, "(BeginX+EndX)/2") +
        cell("PinY", 7, "(BeginY+EndY)/2") +
        cell("Width", 1.5, "SQRT((EndX-BeginX)^2+(EndY-BeginY)^2)") +
        cell("Height", 0) +
        cell("LocPinX", 0.75, "Width*0.5") +
        cell("LocPinY", 0, "Height*0.5") +
        cell("Angle", 0, "ATAN2(EndY-BeginY,EndX-BeginX)") +
        cell("BeginX", 3, "PAR(PNT(Sheet.1!Connections.X2,Sheet.1!Connections.Y2))") +
        cell("BeginY", 7, "PAR(PNT(Sheet.1!Connections.X2,Sheet.1!Connections.Y2))") +
        cell("EndX", 4.5, "PAR(PNT(Sheet.2!Connections.X1,Sheet.2!Connections.Y1))") +
        cell("EndY", 7, "PAR(PNT(Sheet.2!Connections.X1,Sheet.2!Connections.Y1))") +
        geom(
          0,
          row("MoveTo", 1, cell("X", 0, "Width*0") + cell("Y", 0)) +
            row("LineTo", 2, cell("X", 1.5, "Width*1") + cell("Y", 0)),
          cell("NoFill", 1),
        ),
    ) +
    // 5: group rotated by 30 degrees, with two children in its local frame
    shape(
      5,
      `LineStyle="0" FillStyle="0" TextStyle="0"`,
      xform(8.5, 4, 2, 2, cell("Angle", 0.5235987756)),
      "Group",
      "Group.5",
    ).replace(
      "</Shape>",
      `<Shapes>` +
        shape(
          6,
          `LineStyle="0" FillStyle="0" TextStyle="0"`,
          cell("PinX", 1, "Sheet.5!Width*0.5") +
            cell("PinY", 1) +
            cell("Width", 2) +
            cell("Height", 2) +
            cell("LocPinX", 1, "Width*0.5") +
            cell("LocPinY", 1, "Height*0.5") +
            cell("FillForegnd", "#f4b183") +
            geom(0, rectRows("2", "2")),
        ) +
        shape(
          7,
          `LineStyle="0" FillStyle="0" TextStyle="0"`,
          xform(1, 1, 1, 1) +
            cell("FillForegnd", "#ffffff") +
            geom(
              0,
              row("Ellipse", 1, cell("X", 0.5) + cell("Y", 0.5) + cell("A", 1) + cell("B", 0.5) + cell("C", 0.5) + cell("D", 1)),
            ) +
            text("In group"),
        ) +
        `</Shapes></Shape>`,
    ) +
    // 8: horizontally flipped triangle
    shape(
      8,
      `LineStyle="0" FillStyle="0" TextStyle="0"`,
      xform(5, 4, 1.5, 1.5, cell("FlipX", 1)) +
        cell("FillForegnd", "#a9d18e") +
        geom(
          0,
          row("MoveTo", 1, cell("X", 0) + cell("Y", 0)) +
            row("LineTo", 2, cell("X", 1.5) + cell("Y", 0)) +
            row("LineTo", 3, cell("X", 0) + cell("Y", 1.5)) +
            row("LineTo", 4, cell("X", 0) + cell("Y", 0)),
        ),
    ) +
    // 9: bulge arc ("D" shape) + elliptical arc
    shape(
      9,
      `LineStyle="0" FillStyle="0" TextStyle="0"`,
      xform(2, 2, 2, 1) +
        cell("FillForegnd", "#c9c9ff") +
        geom(
          0,
          row("MoveTo", 1, cell("X", 0) + cell("Y", 0)) +
            row("LineTo", 2, cell("X", 1) + cell("Y", 0)) +
            row("EllipticalArcTo", 3, cell("X", 1) + cell("Y", 1) + cell("A", 2) + cell("B", 0.5) + cell("C", 0) + cell("D", 1)) +
            row("LineTo", 4, cell("X", 0) + cell("Y", 1)) +
            row("LineTo", 5, cell("X", 0) + cell("Y", 0)),
        ) +
        text("Arc\u2028second line\tTabbed"),
    ) +
    // 10: text-only shape, left aligned via its own paragraph section
    shape(
      10,
      `LineStyle="0" FillStyle="0" TextStyle="0"`,
      xform(5.5, 2, 3, 0.6) +
        `<Section N="Paragraph"><Row IX="0">${cell("HorzAlign", 0)}</Row></Section>` +
        text("Free-floating text"),
    ) +
    // 11: rotated, dashed rectangle
    shape(
      11,
      `LineStyle="0" FillStyle="0" TextStyle="0"`,
      xform(9, 1.5, 1.6, 0.8, cell("Angle", 0.7853981634)) +
        cell("FillPattern", 0) +
        cell("LinePattern", 2) +
        cell("LineColor", "#c00000") +
        geom(0, rectRows("1.6", "0.8")) +
        text("Dashed"),
    ) +
    // 12: unglued orthogonal polyline (down, right, down) from Start's bottom edge to Decision's
    //     top edge: the kind of line many files draw instead of a real connector.
    shape(
      12,
      `LineStyle="0" FillStyle="0" TextStyle="0"`,
      xform(2, 5.8, 1, 1.4) +
        cell("EndArrow", 4) +
        geom(
          0,
          row("MoveTo", 1, cell("X", 0, "Width*0") + cell("Y", 1.4, "Height*1")) +
            row("LineTo", 2, cell("X", 0, "Width*0") + cell("Y", 0.7, "Height*0.5")) +
            row("LineTo", 3, cell("X", 1, "Width*1") + cell("Y", 0.7, "Height*0.5")) +
            row("LineTo", 4, cell("X", 1, "Width*1") + cell("Y", 0, "Height*0")),
          cell("NoFill", 1),
        ),
    ) +
    // 13: a picture larger than its frame and offset from it (Visio crops it to the frame)
    shape(
      13,
      `LineStyle="0" FillStyle="0" TextStyle="0"`,
      cell("PinX", 9.5) +
        cell("PinY", 7) +
        cell("Width", 1) +
        cell("Height", 0.5) +
        cell("LocPinX", 0.5, "Width*0.5") +
        cell("LocPinY", 0.25, "Height*0.5") +
        cell("ImgOffsetX", -0.25, "ImgWidth*-0.1666666667") +
        cell("ImgOffsetY", 0) +
        cell("ImgWidth", 1.5, "Width*1.5") +
        cell("ImgHeight", 0.5, "Height*1") +
        `<ForeignData ForeignType="Bitmap" CompressionType="PNG"><Rel r:id="rId1"/></ForeignData>`,
      "Foreign",
    );

  zip.file(
    "visio/media/image1.png",
    // 1x1 PNG
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    { base64: true },
  );
  zip.file(
    "visio/pages/_rels/page1.xml.rels",
    `<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>`,
  );

  zip.file(
    "visio/pages/page1.xml",
    pageXml(
      page1,
      `<Connect FromSheet="4" FromCell="BeginX" FromPart="9" ToSheet="1" ToCell="PinX" ToPart="3"/>` +
        `<Connect FromSheet="4" FromCell="EndX" FromPart="12" ToSheet="2" ToCell="PinX" ToPart="3"/>`,
    ),
  );

  // --- page 2: a small page with one shape ---------------------------------------------
  zip.file(
    "visio/pages/page2.xml",
    pageXml(
      shape(
        1,
        `Master="1"`,
        xform(3, 2, 2, 1) + text("Page two"),
        "Shape",
        "Process.1",
      ),
    ),
  );

  // --- page 3: background page (shapes appear under page 1) -------------------------------
  zip.file(
    "visio/pages/page3.xml",
    pageXml(
      shape(
        1,
        `LineStyle="0" FillStyle="0" TextStyle="0"`,
        xform(5.5, 8, 4, 0.5) + text("Background page title"),
      ),
    ),
  );

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
