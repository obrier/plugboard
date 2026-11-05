// The licenses of the packages bundled into the library, read from the bundle itself: Bun marks each module it
// bundles with a `// node_modules/<package>/…` comment. A bundled package without a license file stops the build.
// Usage: bun scripts/third-party-licenses.ts <bundle.js> <out.txt>
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [bundle, out] = Bun.argv.slice(2);
if (!bundle || !out) throw new Error("usage: bun scripts/third-party-licenses.ts <bundle.js> <out.txt>");
const names = new Set<string>();
for (const [, name] of readFileSync(bundle, "utf8").matchAll(/^\/\/ node_modules\/((?:@[^/]+\/)?[^/]+)\//gm)) names.add(name!);
if (!names.size) throw new Error(`${bundle}: no bundled packages found (is it minified?)`);

const sections = [...names].sort().map(name => {
  const dir = join("node_modules", name);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string; license?: string };
  const file = readdirSync(dir).find(f => /^(licen[sc]e|copying)(\.|$)/i.test(f));
  if (!file || !existsSync(join(dir, file))) throw new Error(`${name} is bundled but has no license file`);
  return `${name} ${pkg.version} (${pkg.license ?? "see below"})\n\n${readFileSync(join(dir, file), "utf8").trim()}\n`;
});
writeFileSync(out, `Third-party software bundled in @obrier/plugboard\n\n${sections.join(`\n${"-".repeat(72)}\n\n`)}`);
console.log(`${out}: ${[...names].sort().join(", ")}`);
