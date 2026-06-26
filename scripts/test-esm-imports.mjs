/**
 * ESM import/export link checker.
 *
 * Catches the class of bug that bricks the whole module in the BROWSER but
 * sails through the node unit tests: a static `import { X } from "./y.js"`
 * where `y.js` does not actually export `X`. In a browser this is a fatal
 * module-instantiation (link-time) SyntaxError thrown before any code runs,
 * and it propagates up the import chain — so if it reaches scripts/module.js
 * (the esmodules entry) NONE of its Hooks register and the entire module
 * becomes inaccessible while still showing ACTIVE.
 *
 * Node's per-file unit tests miss it because they only link the specific
 * modules they import; a window/App module with a bad binding is never linked.
 * This check statically resolves every relative import in scripts/ against the
 * target file's real export surface (including `export ... from` re-exports and
 * `export *` star re-exports), so the link error is caught in CI instead of in
 * production.
 *
 * Pure node, no deps. Best-effort static parser for standard ESM syntax.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = __dirname;

/** All .js/.mjs files under scripts/ (recursively). */
function listSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...listSourceFiles(full));
    } else if (/\.(js|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Strip line + block comments so they don't confuse the regex parsers. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const namedListRe = /\{([\s\S]*?)\}/;

function parseSpecifierList(body) {
  return body
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.split(/\s+as\s+/);
      return { imported: m[0].trim(), local: (m[1] ?? m[0]).trim() };
    });
}

/**
 * Collect a file's direct export surface plus its re-export edges.
 * Returns { names:Set, hasDefault:bool, star:[absPaths], reexport:[{names,from}] }
 */
function parseExports(absFile, src) {
  const names = new Set();
  let hasDefault = false;
  const star = [];
  const reexport = [];

  // export { a, b as c }            -> exports a, c   (no `from`)
  // export { a, b as c } from "./x" -> re-exports from x as a, c
  const exportBraceRe = /export\s*\{([\s\S]*?)\}\s*(?:from\s*["']([^"']+)["'])?/g;
  let m;
  while ((m = exportBraceRe.exec(src))) {
    const specs = parseSpecifierList(m[1]);
    const from = m[2];
    if (from) {
      const resolved = resolveImport(absFile, from);
      reexport.push({
        names: specs.map((s) => s.local), // exported-as name
        from: resolved,
      });
    } else {
      for (const s of specs) {
        if (s.local === "default") hasDefault = true;
        else names.add(s.local);
      }
    }
  }

  // export * from "./x"  and  export * as ns from "./x"
  const starRe = /export\s*\*\s*(?:as\s+(\w+)\s+)?from\s*["']([^"']+)["']/g;
  while ((m = starRe.exec(src))) {
    const asNs = m[1];
    const resolved = resolveImport(absFile, m[2]);
    if (asNs) names.add(asNs);
    else if (resolved) star.push(resolved);
  }

  // export function/class/const/let/var name
  const declRe =
    /export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = declRe.exec(src))) names.add(m[1]);

  // export default
  if (/export\s+default\b/.test(src)) hasDefault = true;

  return { names, hasDefault, star, reexport };
}

function resolveImport(fromFile, spec) {
  if (!spec.startsWith(".")) return null; // bare / external — not our concern
  let target = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;
  for (const ext of [".js", ".mjs"]) {
    if (fs.existsSync(target + ext)) return target + ext;
  }
  const idx = path.join(target, "index.js");
  if (fs.existsSync(idx)) return idx;
  return target; // report as missing-file later
}

// ---- Build the export map for every file --------------------------------
const files = listSourceFiles(scriptsDir);
const exportsByFile = new Map();
const srcByFile = new Map();
for (const f of files) {
  const src = stripComments(fs.readFileSync(f, "utf8"));
  srcByFile.set(f, src);
  exportsByFile.set(f, parseExports(f, src));
}

/** Resolve whether `name` is exported by file, following re-export edges. */
function exportsName(file, name, seen = new Set()) {
  if (!file || seen.has(file)) return false;
  seen.add(file);
  const info = exportsByFile.get(file);
  if (!info) return null; // unknown file (maybe outside scripts/)
  if (info.names.has(name)) return true;
  for (const re of info.reexport) {
    if (re.names.includes(name)) return true;
  }
  for (const star of info.star) {
    if (exportsName(star, name, seen) === true) return true;
  }
  return false;
}

function hasDefault(file, seen = new Set()) {
  if (!file || seen.has(file)) return false;
  seen.add(file);
  const info = exportsByFile.get(file);
  if (!info) return null;
  if (info.hasDefault) return true;
  for (const star of info.star) if (hasDefault(star, seen) === true) return true;
  return false;
}

// ---- Check every relative import ----------------------------------------
const problems = [];
let importCount = 0;

const importRe =
  /import\s+(?:([\s\S]*?)\s+from\s+)?["']([^"']+)["']/g;

for (const f of files) {
  const src = srcByFile.get(f);
  let m;
  while ((m = importRe.exec(src))) {
    const clause = (m[1] ?? "").trim();
    const spec = m[2];
    if (!spec.startsWith(".")) continue; // external
    const target = resolveImport(f, spec);
    const rel = path.relative(scriptsDir, f).replace(/\\/g, "/");
    if (!target || !exportsByFile.has(target)) {
      problems.push(`${rel}: imports from "${spec}" but target file not found`);
      continue;
    }
    if (!clause) continue; // side-effect import: `import "./x.js"`

    // namespace import: `* as ns`
    if (/^\*\s+as\s+/.test(clause)) {
      importCount += 1;
      continue;
    }

    // default + maybe named: `Default`, `Default, { a, b }`, `{ a, b }`
    const braceMatch = clause.match(namedListRe);
    const beforeBrace = clause.split("{")[0].replace(/,$/, "").trim();
    if (beforeBrace && !beforeBrace.startsWith("*")) {
      importCount += 1;
      if (hasDefault(target) === false) {
        problems.push(
          `${rel}: imports default from "${spec}" but it has no default export`,
        );
      }
    }
    if (braceMatch) {
      for (const s of parseSpecifierList(braceMatch[1])) {
        importCount += 1;
        const ok = exportsName(target, s.imported);
        if (ok === false) {
          problems.push(
            `${rel}: imports { ${s.imported} } from "${spec}" but ` +
              `${path.relative(scriptsDir, target).replace(/\\/g, "/")} ` +
              `does not export "${s.imported}"`,
          );
        }
      }
    }
  }
}

if (problems.length) {
  console.error("ESM import/export link check FAILED:\n");
  for (const p of problems) console.error("  ✗ " + p);
  console.error(
    `\n${problems.length} unresolved import(s). In the browser these are fatal ` +
      `link-time errors that brick the whole module.`,
  );
  process.exit(1);
}

console.log(
  `esm import/export link check passed (${files.length} files, ${importCount} named/default imports resolved)`,
);
