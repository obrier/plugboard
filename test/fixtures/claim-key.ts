// One process claiming a key, for the multi-process race test: prints "claimed" or "refused".
import { claimKey } from "../../src/audit";
const at = Number(process.argv[2]);
while (Date.now() < at) { /* start together */ }
const claim = claimKey("same", { key: "same", status: "attempt", pid: process.pid, deadline_ms: 30_000 });
console.log(claim.claimed ? "claimed" : "refused");
