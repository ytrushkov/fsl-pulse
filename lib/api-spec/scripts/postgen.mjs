// Post-codegen cleanup for orval output.
//
// Some endpoint *Params shapes are emitted twice: once as a TS type under
// `lib/api-zod/src/generated/types/` and once as a runtime zod schema under
// `lib/api-zod/src/generated/api.ts`. Re-exporting both via `index.ts` causes
// TS2308 ("already exported"). The runtime zod schemas are the source of
// truth (callers can derive types via `z.infer`), so we strip the duplicate
// type-only barrel entries here.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const typesIndex = resolve(here, "..", "..", "api-zod", "src", "generated", "types", "index.ts");
const apiFile = resolve(here, "..", "..", "api-zod", "src", "generated", "api.ts");

const apiSrc = readFileSync(apiFile, "utf8");
const zodNames = new Set(
  Array.from(apiSrc.matchAll(/^export const (\w+) = zod\./gm), (m) => m[1]),
);

let idx = readFileSync(typesIndex, "utf8");
const before = idx;
idx = idx
  .split("\n")
  .filter((line) => {
    const m = line.match(/^export \* from "\.\/(\w+)";$/);
    if (!m) return true;
    // Convert filename camelCase -> exported type name (PascalCase)
    const name = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    return !zodNames.has(name);
  })
  .join("\n");

if (idx !== before) {
  writeFileSync(typesIndex, idx);
  console.log("[postgen] pruned duplicate barrel entries from generated/types/index.ts");
}
