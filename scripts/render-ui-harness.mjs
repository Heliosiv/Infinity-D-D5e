import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildUiHarnessDocument } from "./ui-harness.mjs";

const outDir = path.resolve("tmp", "playwright");
const outFile = path.join(outDir, "ui-harness.html");

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, buildUiHarnessDocument(), "utf8");

process.stdout.write(`${outFile}\n`);
