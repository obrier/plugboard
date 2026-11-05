// Prints bytes [off-before, off+after) of a file. Usage: bun at.ts <file> <offset> [before] [after]
const [file, off, before = "1000", after = "2000"] = Bun.argv.slice(2);
const o = Number(off);
const buf = await Bun.file(file).slice(Math.max(0, o - Number(before)), o + Number(after)).text();
console.log(buf);
