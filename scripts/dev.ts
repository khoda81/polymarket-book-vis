import { createServer } from "node:net";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const sshHost = process.env.RECORDER_SSH_HOST || "polyviz";
const startupTimeoutMs = 15_000;
const children: {
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
  kill(): void;
}[] = [];
let stopping = false;

function stopChildren(): void {
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
}

function stop(): void {
  stopping = true;
  stopChildren();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close();
        reject(new Error("Could not allocate the recorder tunnel port"));
        return;
      }
      listener.close((error) =>
        error ? reject(error) : resolve(address.port),
      );
    });
  });
}

try {
  let target = process.env.RECORDER_PROXY_TARGET;
  let ssh: ReturnType<typeof Bun.spawn> | undefined;
  if (!target) {
    const port = await availablePort();
    target = `http://127.0.0.1:${port}`;
    console.log(`Connecting to recorder through ssh ${sshHost}…`);
    ssh = Bun.spawn(
      [
        "ssh",
        "-N",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        "-L",
        `127.0.0.1:${port}:127.0.0.1:3001`,
        sshHost,
      ],
      { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
    );
    children.push(ssh);
    const deadline = Date.now() + startupTimeoutMs;
    let healthy = false;
    while (!stopping && Date.now() < deadline) {
      if (ssh.exitCode !== null)
        throw new Error(`Recorder SSH connection exited (${ssh.exitCode})`);
      try {
        const response = await fetch(`${target}/api/recorder/health`, {
          signal: AbortSignal.timeout(1_000),
        });
        healthy = response.ok;
        await response.body?.cancel();
        if (healthy) break;
      } catch {
        // The local forward is not ready until SSH has authenticated.
      }
      await Bun.sleep(100);
    }
    if (!healthy && !stopping)
      throw new Error(`Recorder on ${sshHost}:3001 did not become healthy`);
    if (healthy) console.log(`Remote recorder ready (${sshHost}:3001).`);
  }

  if (!stopping) {
    const vite = Bun.spawn(
      [join(root, "node_modules/.bin/vite"), ...Bun.argv.slice(2)],
      {
        cwd: root,
        env: { ...process.env, RECORDER_PROXY_TARGET: target },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    children.push(vite);
    const exit = vite.exited;
    const result = ssh
      ? await Promise.race([
          exit,
          ssh.exited.then(() => {
            if (!stopping) throw new Error("Recorder SSH connection closed");
            return 0;
          }),
        ])
      : await exit;
    process.exitCode = stopping ? 0 : result;
  }
} catch (error) {
  if (!stopping) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
} finally {
  stopChildren();
  await Promise.all(children.map((child) => child.exited));
}
