// Alternates probe variants N times and prints per-run lines and medians.
// Usage: bun bench.ts <runs> "<variant args>" ["<variant args>" ...]   ("" = baseline)
const [runs, ...variants] = Bun.argv.slice(2);
const results: Record<string, any[]> = Object.fromEntries(variants.map(v => [v, []]));
for (let i = 0; i < Number(runs); i++) for (const v of variants) {
  const p = Bun.spawnSync(["bun", `${import.meta.dir}/probe.ts`, ...v.split(" ").filter(Boolean)]);
  const r = JSON.parse(p.stdout.toString().trim().split("\n").pop()!);
  results[v].push(r);
  console.log(`run ${i + 1} [${v || "baseline"}] ${JSON.stringify(r)}`);
}
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
for (const v of variants) {
  const rs = results[v].filter(r => !r.error);
  const keys = ["initialize", "discovered", "call", "total"];
  console.log(`median [${v || "baseline"}] n=${rs.length} ` + keys.map(k => `${k}=${median(rs.map(r => r[k]))}`).join(" ")
    + ` zeroCost=${rs.every(r => r.zeroCost)}` + (rs[0]?.warmCalls ? ` warmCall=${median(rs.flatMap(r => r.warmCalls))}` : ""));
}
