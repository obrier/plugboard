// Prints a window of text around each match of a literal in a large strings dump.
// Usage: bun ctx.ts <file> <literal> [before] [after] [max]
const [file, needle, before = "800", after = "1500", max = "3"] = Bun.argv.slice(2);
const text = await Bun.file(file).text();
let i = 0, n = 0;
while ((i = text.indexOf(needle, i)) !== -1 && n < Number(max)) {
  console.log(`--- @${i}\n` + text.slice(Math.max(0, i - Number(before)), i + Number(after)));
  i += needle.length; n++;
}
