// Both runtimes' implementations, run here under Bun: Bun implements node:child_process and node:http,
// so the Node path's own code is exercised too. A Node smoke run covers real Node (see the PR).
import { describe, expect, test } from "bun:test";
import { bunRuntime, nodeRuntime, runtime, type Runtime } from "../src/runtime";

const text = async (chunks: AsyncIterable<Uint8Array>) => { let s = ""; const d = new TextDecoder(); for await (const c of chunks) s += d.decode(c, { stream: true }); return s + d.decode(); };

describe.each([["bun", bunRuntime], ["node", nodeRuntime]] as [string, Runtime][])("%s runtime", (_name, rt) => {
  test("spawn: stdin in, stdout out, exit code", async () => {
    const proc = rt.spawn(["sh", "-c", "read line; echo \"got $line\"; echo err >&2; exit 3"], { cwd: process.cwd(), env: process.env });
    expect(proc.exitCode).toBeNull();
    proc.stdin.write("hello\n");
    proc.stdin.flush();
    proc.stdin.end();
    const [out, err] = await Promise.all([text(proc.stdout), text(proc.stderr)]);
    expect(out).toBe("got hello\n");
    expect(err).toBe("err\n");
    expect(await proc.exited).toBe(3);
    expect(proc.exitCode).toBe(3);
  });

  test("spawn: kill ends a running process", async () => {
    const proc = rt.spawn(["sleep", "30"], { cwd: process.cwd(), env: process.env });
    proc.kill("SIGKILL");
    await proc.exited;
    expect(proc.exitCode).not.toBe(0);
  });

  test("spawnSync: exit code and stdout", () => {
    expect(rt.spawnSync(["sh", "-c", "echo hi"], { env: process.env })).toEqual({ exitCode: 0, stdout: "hi\n" });
    expect(rt.spawnSync(["sh", "-c", "exit 2"], { env: process.env }).exitCode).toBe(2);
  });

  test("serve: a fetch handler on a loopback port, with the request's method, path and JSON body", async () => {
    const seen: string[] = [];
    const server = await rt.serve(async request => {
      let body: unknown;
      try { body = await request.json(); } catch { /* no body */ }
      seen.push(`${request.method} ${new URL(request.url).pathname} ${JSON.stringify(body)}`);
      return Response.json({ ok: true }, { status: 400 });
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, { method: "POST", body: JSON.stringify({ tools: [1] }), headers: { "content-type": "application/json" } });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: true });
      expect((await fetch(`http://127.0.0.1:${server.port}/api/hello`, { method: "HEAD" })).status).toBe(400);
      expect(seen).toEqual(['POST /v1/messages {"tools":[1]}', "HEAD /api/hello undefined"]);
    } finally { server.stop(); }
  });

  test("parseToml: tables and quoted keys; a syntax error throws", () => {
    expect(rt.parseToml('[transforms]\n"slack:search.after" = "unix"\n[profiles.x]\nmode = "read"\n'))
      .toEqual({ transforms: { "slack:search.after": "unix" }, profiles: { x: { mode: "read" } } });
    expect(() => rt.parseToml("[transforms\n")).toThrow();
  });
});

test("the CLI's runtime under Bun is Bun's", () => {
  expect(runtime).toBe(bunRuntime);
});
