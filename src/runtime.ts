// The few runtime APIs plugboard uses where Bun and Node differ, chosen once by detection: the CLI,
// compiled with Bun, always takes Bun's; the library takes Node's when it runs on Node.
// APIs both runtimes share (node:fs, node:timers/promises) are used directly, not through here.
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { createServer } from "node:http";
import { parse as smolToml } from "smol-toml";

type Env = Record<string, string | undefined>;
export type Proc = {
  stdin: { write(text: string): void; flush(): void; end(): void };
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  /** null while it runs. */
  readonly exitCode: number | null;
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
};
export type Server = { port: number; stop(): void };
export type Runtime = {
  spawn(cmd: string[], o: { cwd: string; env: Env }): Proc;
  spawnSync(cmd: string[], o: { env: Env }): { exitCode: number | null; stdout: string };
  /** A fetch handler on 127.0.0.1, on a free port. */
  serve(fetch: (request: Request) => Promise<Response>): Promise<Server>;
  parseToml(text: string): Record<string, unknown>;
};

export const bunRuntime: Runtime = {
  spawn(cmd, { cwd, env }) {
    const proc = Bun.spawn(cmd, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    return {
      stdin: { write: text => { proc.stdin.write(text); }, flush: () => { proc.stdin.flush(); }, end: () => { proc.stdin.end(); } },
      stdout: proc.stdout, stderr: proc.stderr,
      get exitCode() { return proc.exitCode; },
      exited: proc.exited,
      kill: signal => proc.kill(signal),
    };
  },
  spawnSync(cmd, { env }) {
    const proc = Bun.spawnSync(cmd, { env, stdout: "pipe", stderr: "ignore" });
    return { exitCode: proc.exitCode, stdout: proc.stdout.toString() };
  },
  async serve(fetch) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
    return { port: server.port!, stop: () => { server.stop(true); } };
  },
  parseToml: text => Bun.TOML.parse(text) as Record<string, unknown>,
};

export const nodeRuntime: Runtime = {
  spawn(cmd, { cwd, env }) {
    const child = nodeSpawn(cmd[0]!, cmd.slice(1), { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    // A spawn error (a missing or non-executable file) arrives as an event, not a throw: surface it on the streams' readers.
    const failed = new Promise<never>((_, reject) => child.once("error", reject));
    failed.catch(() => {});
    const exited = new Promise<number>(resolve => child.once("close", (code, signal) => resolve(code ?? (signal ? 128 : 1))));
    child.stdin.on("error", () => {}); // writing to a process that exited: the reader reports it
    async function* stream(readable: NodeJS.ReadableStream) {
      const iterator = (readable as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
      while (true) {
        const next = await Promise.race([iterator.next(), failed]);
        if (next.done) return;
        yield next.value;
      }
    }
    return {
      stdin: { write: text => { child.stdin.write(text); }, flush: () => {}, end: () => { child.stdin.end(); } },
      stdout: stream(child.stdout), stderr: stream(child.stderr),
      get exitCode() { return child.exitCode ?? (child.signalCode ? 128 : null); },
      exited,
      kill: signal => { child.kill(signal); },
    };
  },
  spawnSync(cmd, { env }) {
    const proc = nodeSpawnSync(cmd[0]!, cmd.slice(1), { env, stdio: ["ignore", "pipe", "ignore"] });
    if (proc.error) throw proc.error;
    return { exitCode: proc.status, stdout: proc.stdout.toString() };
  },
  serve(fetch) {
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(key, value);
        const response = await fetch(new Request(`http://127.0.0.1${req.url ?? "/"}`, { method: req.method, headers, ...(hasBody ? { body: Buffer.concat(chunks) } : {}) }));
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(req.method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(500).end(); }
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve({ port: typeof address === "object" && address ? address.port : 0, stop: () => { server.closeAllConnections(); server.close(); } });
      });
    });
  },
  parseToml: text => smolToml(text) as Record<string, unknown>,
};

export const runtime: Runtime = typeof Bun !== "undefined" ? bunRuntime : nodeRuntime;
