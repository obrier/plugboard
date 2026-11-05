// The runtime APIs plugboard uses where Bun and Node differ, chosen once by detection: the CLI,
// compiled with Bun, always takes Bun's; the library takes Node's when it runs on Node.
// APIs both runtimes share (node:fs, node:timers/promises) are used directly, not through here.
// Both implementations keep one contract: spawn resolves once the process started (or rejects
// with the errno), and a process killed by a signal exits 128 + the signal's number.
// spawn is node:child_process's on both: under Bun, a child whose output is being read keeps the program
// running even once unref'd (checked on Bun 1.4), and an idle child must never keep a program from exiting.
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { createServer } from "node:http";
import { constants } from "node:os";

type Env = Record<string, string | undefined>;
export type Proc = {
  stdin: { write(text: string): void; flush(): void; end(): void };
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  /** null while it runs; its exit status once it has exited. */
  readonly exitCode: number | null;
  /** Its exit status: the code, or 128 + the signal's number. */
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
  /** Lets the program exit while this process runs, its pipes included. */
  unref(): void;
};
export type Server = { port: number; stop(): void };
export type Runtime = {
  /** "bun 1.4.0" or "node 26.8.1". */
  name: string;
  /** Resolves once the process started; rejects with the errno (EACCES, ENOENT) when it can't. */
  spawn(cmd: string[], o: { cwd: string; env: Env }): Promise<Proc>;
  spawnSync(cmd: string[], o: { env: Env }): { exitCode: number | null; stdout: string };
  /** A fetch handler on 127.0.0.1, on a free port. A handler that throws answers 500; a body that fails
   * mid-response is cut short, and its status may already be sent (Bun sends its own; Node answers 500). */
  serve(fetch: (request: Request) => Promise<Response>): Promise<Server>;
};

const status = (code: number | null, signal: string | null) =>
  code ?? (signal ? 128 + (constants.signals[signal as NodeJS.Signals] ?? 0) : null);

async function spawn(cmd: string[], { cwd, env }: { cwd: string; env: Env }): Promise<Proc> {
  const child = nodeSpawn(cmd[0]!, cmd.slice(1), { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  // Node reports a failed start as an event, not a throw: wait for one or the other.
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const exited = new Promise<number>(resolve => child.once("close", (code, signal) => resolve(status(code, signal) ?? 1)));
  child.stdin.on("error", () => {}); // writing to a process that exited: its reader reports it
  return {
    stdin: { write: text => { child.stdin.write(text); }, flush: () => {}, end: () => { child.stdin.end(); } },
    stdout: child.stdout, stderr: child.stderr,
    get exitCode() { return status(child.exitCode, child.signalCode); },
    exited,
    kill: signal => { child.kill(signal); },
    unref: () => { child.unref(); for (const pipe of [child.stdin, child.stdout, child.stderr]) (pipe as { unref?: () => void }).unref?.(); },
  };
}

export const bunRuntime: Runtime = {
  name: `bun ${process.versions.bun}`,
  spawn,
  spawnSync(cmd, { env }) {
    const proc = Bun.spawnSync(cmd, { env, stdout: "pipe", stderr: "ignore" });
    return { exitCode: proc.exitCode, stdout: proc.stdout.toString() };
  },
  async serve(fetch) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch, error: () => new Response(null, { status: 500 }) }); // a throw answers 500, as on Node
    return { port: server.port!, stop: () => { server.stop(true); } };
  },
};

export const nodeRuntime: Runtime = {
  name: `node ${process.versions.node}`,
  spawn,
  spawnSync(cmd, { env }) {
    const proc = nodeSpawnSync(cmd[0]!, cmd.slice(1), { env, stdio: ["ignore", "pipe", "ignore"] });
    if (proc.error) throw proc.error;
    return { exitCode: proc.status, stdout: proc.stdout.toString() };
  },
  serve(fetch) {
    let port = 0;
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers))
          for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(key, v);
        const response = await fetch(new Request(`http://127.0.0.1:${port}${req.url ?? "/"}`, { method: req.method, headers, ...(hasBody ? { body: Buffer.concat(chunks) } : {}) }));
        response.headers.forEach((value, key) => { if (key !== "set-cookie") res.setHeader(key, value); });
        const cookies = response.headers.getSetCookie();
        if (cookies.length) res.setHeader("set-cookie", cookies);
        res.statusCode = response.status;
        const body = req.method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer());
        res.end(body);
      } catch {
        // Before the head is sent, answer 500; after, the response can only be cut short.
        if (res.headersSent) res.destroy();
        else { for (const name of res.getHeaderNames()) res.removeHeader(name); res.writeHead(500).end(); } // none of the failed response's headers
      }
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        port = typeof address === "object" && address ? address.port : 0;
        resolve({ port, stop: () => { server.closeAllConnections(); server.close(); } });
      });
    });
  },
};

export const runtime: Runtime = typeof Bun !== "undefined" ? bunRuntime : nodeRuntime;
