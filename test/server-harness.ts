/**
 * Starts the real server binary for a test, on a port the OS chooses.
 *
 * Picking a random port and hoping is not good enough: vitest runs test files
 * in parallel, so two files can choose the same one, and a port that looks free
 * when you check it can be taken by the time you bind. Asking for port 0 and
 * reading back what the server actually got removes the race entirely.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RunningServer {
  baseUrl: string;
  port: number;
  stop(): Promise<void>;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

export async function startServer(opts: {
  binary: string;
  dataDir: string;
  configDir: string;
  /** deviceId -> plaintext token */
  devices: Record<string, string>;
  extraConfig?: string;
}): Promise<RunningServer> {
  if (!existsSync(opts.binary)) {
    throw new Error(
      `Missing ${opts.binary}. Run: cargo build --package obsydian-sync-server\n` +
        `(\`npm test\` does this for you via the pretest script.)`,
    );
  }

  const deviceBlocks = Object.entries(opts.devices).map(([id, token]) => {
    const digest = execFileSync(opts.binary, ["--hash-token"], {
      input: token,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    return `\n[[devices]]\nid = "${id}"\ntoken_sha256 = "${digest}"\n`;
  });

  const configPath = join(opts.configDir, "config.toml");
  writeFileSync(
    configPath,
    // Port 0: the OS assigns one, and the server reports it.
    `bind = "127.0.0.1:0"\ndata_dir = "${opts.dataDir}"\n${opts.extraConfig ?? ""}${deviceBlocks.join("")}`,
  );

  // Both streams are watched: tracing writes to stdout by default, but a panic
  // or a config error arrives on stderr, and a harness that reads only one of
  // them reports a timeout when the real cause was printed on the other.
  const child: ChildProcess = spawn(opts.binary, [configPath], {
    stdio: ["ignore", "pipe", "pipe"],
    // Without this the log arrives as `local\x1b[0m\x1b[2m=\x1b[0m127.0.0.1:1234`
    // and a naive pattern silently never matches.
    env: { ...process.env, NO_COLOR: "1" },
  });

  const port = await new Promise<number>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      reject(new Error(`server did not report a port within 15s. output:\n${output || "(none)"}`));
    }, 15_000);

    const watch = (chunk: unknown) => {
      // Belt and braces alongside NO_COLOR: strip any escape sequences, so a
      // colourised line still matches rather than timing out with the answer
      // visible in the error message.
      output += stripAnsi(String(chunk));
      // The server logs the *resolved* address, which is the only way to learn
      // the port when the config says 0.
      const match = /local=127\.0\.0\.1:(\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    };
    child.stdout?.on("data", watch);
    child.stderr?.on("data", watch);

    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with code ${code} before listening. output:\n${output || "(none)"}`));
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    async stop() {
      if (child.exitCode !== null) return;
      // Wait for the process to actually go before the caller deletes its data
      // directory out from under it.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGTERM");
      });
    },
  };
}
