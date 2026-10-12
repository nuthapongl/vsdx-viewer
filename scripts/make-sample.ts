import { mkdir, writeFile } from "node:fs/promises";
import { buildSampleVsdx } from "./sampleVsdx.ts";

await mkdir("public", { recursive: true });
await writeFile("public/sample.vsdx", await buildSampleVsdx());
console.log("wrote public/sample.vsdx");
