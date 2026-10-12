// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyMods, luminance, parseTheme } from "./theme";

const THEME = `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:vt="v"><a:themeElements><a:fmtScheme>
<a:fillStyleLst>
 <a:gradFill><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:satMod val="99000"/><a:lumMod val="147000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="94000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000"/></a:gradFill>
 <a:solidFill><a:schemeClr val="phClr"><a:lumMod val="83000"/></a:schemeClr></a:solidFill>
</a:fillStyleLst>
<a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"><a:lumMod val="70000"/></a:schemeClr></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst><a:outerShdw blurRad="63500" dist="38100" dir="5400000"><a:schemeClr val="dk1"><a:alpha val="60000"/></a:schemeClr></a:outerShdw></a:effectLst></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
</a:fmtScheme>
<a:extLst><vt:variationClrScheme><vt:varColor1><a:srgbClr val="1E5155"/></vt:varColor1><vt:varColor2><a:srgbClr val="B01513"/></vt:varColor2></vt:variationClrScheme>
<vt:variationStyleScheme><vt:varStyle fillIdx="1"/><vt:varStyle fillIdx="2"/></vt:variationStyleScheme></a:extLst>
</a:themeElements></a:theme>`;

describe("themes", () => {
  const theme = parseTheme(new DOMParser().parseFromString(THEME, "application/xml"))!;

  it("reads fill, line and effect styles and the colour variation", () => {
    expect(theme.fills).toHaveLength(2);
    expect(theme.fills[0].angle).toBe(90);
    expect(theme.fills[0].stops.map((s) => s.mods.lumMod)).toEqual([1.47, 0.94]);
    expect(theme.fills[1].stops).toHaveLength(1);
    expect(theme.lines[0].lumMod).toBe(0.7);
    expect(theme.variationColors).toEqual(["#1e5155", "#b01513"]);
    expect(theme.styleIdx).toEqual([1, 2]);
    expect(theme.effects[0]).toMatchObject({ opacity: 0.6, blur: expect.closeTo(6.67, 1) });
    expect(theme.effects[0]!.dy).toBeCloseTo(4, 1);
    expect(theme.effects[1]).toBeNull();
  });

  it("darkens and lightens a colour by its lightness factor", () => {
    expect(luminance(applyMods("#1e5155", { lumMod: 0.7, satMod: 1 }))).toBeLessThan(luminance("#1e5155"));
    expect(luminance(applyMods("#1e5155", { lumMod: 1.47, satMod: 1 }))).toBeGreaterThan(luminance("#1e5155"));
    expect(applyMods("#1e5155", { lumMod: 1, satMod: 1 })).toBe("#1e5155");
  });
});
