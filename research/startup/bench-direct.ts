// Alternates whole commands N times and prints each wall time and the medians (ms).
// Usage: bun bench-direct.ts <runs> <cwd> -- "<command 1>" "<command 2>" ...
const [runs, cwd, sep, ...commands] = Bun.argv.slice(2);
if (sep !== "--") throw new Error("usage: bun bench-direct.ts <runs> <cwd> -- <commands...>");
const times: number[][] = commands.map(() => []);
for (let i = 0; i < Number(runs); i++) commands.forEach((c, j) => {
  const t = performance.now();
  const p = Bun.spawnSync(["sh", "-c", c], { cwd, stdout: "ignore", stderr: "ignore" });
  const ms = Math.round(performance.now() - t);
  times[j].push(ms);
  console.log(`run ${i + 1} exit=${p.exitCode} ${ms}ms  ${c}`);
});
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
commands.forEach((c, j) => console.log(`median ${median(times[j])}ms min ${Math.min(...times[j])} max ${Math.max(...times[j])}  ${c}`));
