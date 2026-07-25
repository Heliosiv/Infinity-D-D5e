import { readFileSync, writeFileSync } from "node:fs";

const PACK = new URL("../packs/infinity-dnd5e-items.db", import.meta.url);
const VALUE_LABEL = /Value:\s*[\d,]+(?:\.\d+)?\s*(?:cp|sp|ep|gp|pp)\b/gi;

const source = readFileSync(PACK, "utf8");
const trailingNewline = source.endsWith("\n");
let changed = 0;
const output = source
  .split(/\r?\n/)
  .filter((line, index, lines) => line || index < lines.length - 1)
  .map((line) => {
    if (!line.trim()) return line;
    const item = JSON.parse(line);
    const value = Number(item.system?.price?.value);
    const denomination = String(
      item.system?.price?.denomination ?? "",
    ).toLowerCase();
    const description = item.system?.description?.value;
    VALUE_LABEL.lastIndex = 0;
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      !["cp", "sp", "ep", "gp", "pp"].includes(denomination) ||
      typeof description !== "string" ||
      !VALUE_LABEL.test(description)
    ) {
      VALUE_LABEL.lastIndex = 0;
      return line;
    }
    VALUE_LABEL.lastIndex = 0;
    const label = `Value: ${value.toLocaleString("en-US", {
      maximumFractionDigits: 4,
    })} ${denomination}`;
    const next = description.replace(VALUE_LABEL, label);
    VALUE_LABEL.lastIndex = 0;
    if (next === description) return line;
    item.system.description.value = next;
    changed += 1;
    return JSON.stringify(item);
  })
  .join("\n");

writeFileSync(PACK, output + (trailingNewline ? "\n" : ""), "utf8");
process.stdout.write(`corrected ${changed} pack value label(s)\n`);
