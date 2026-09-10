import { createServer, type Server } from "node:http";
import { afterEach, expect, test } from "vitest";

import { waitForMetro, warmMetro } from "../e2e/support/global-setup";

interface MetroResponse {
  body: string;
  delayMs?: number;
  status: number;
}

class MetroPort {
  private readonly responses = new Map<string, MetroResponse>();
  readonly requests: string[] = [];

  private constructor(
    readonly port: number,
    private readonly server: Server,
  ) {}

  static async listen(): Promise<MetroPort> {
    let endpoint!: MetroPort;
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      endpoint.requests.push(pathname);
      const served = endpoint.responses.get(pathname) ?? { status: 500, body: "fallback" };
      const send = () => {
        response.writeHead(served.status, { "content-type": "text/plain" });
        response.end(served.body);
      };
      if (served.delayMs) {
        setTimeout(send, served.delayMs);
      } else {
        send();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Failed to listen for Metro readiness test");
    }
    endpoint = new MetroPort(address.port, server);
    return endpoint;
  }

  serveMetro(): void {
    this.responses.set("/status", { status: 200, body: "packager-status:running" });
  }

  serveWarmableDocument(): void {
    this.responses.set("/", {
      status: 200,
      body: '<html><script src="/index.bundle?platform=web"></script></html>',
    });
    this.responses.set("/index.bundle", { status: 200, body: "compiled bundle" });
  }

  delayBundle(delayMs: number): void {
    this.responses.set("/index.bundle", {
      status: 200,
      body: "compiled bundle",
      delayMs,
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

let endpoint: MetroPort | null = null;

afterEach(async () => {
  await endpoint?.close();
  endpoint = null;
});

test("Metro readiness rejects another HTTP listener on the selected port", async () => {
  endpoint = await MetroPort.listen();

  await expect(waitForMetro(endpoint.port, { label: "Metro", timeoutMs: 150 })).rejects.toThrow(
    "Expected Metro status",
  );

  endpoint.serveMetro();
  await expect(waitForMetro(endpoint.port, { label: "Metro", timeoutMs: 150 })).resolves.toBe(
    undefined,
  );
});

test("Metro warmup compiles the document's same-origin scripts before tests start", async () => {
  endpoint = await MetroPort.listen();
  endpoint.serveWarmableDocument();
  const progress: string[] = [];

  await warmMetro(endpoint.port, { reportProgress: (message) => progress.push(message) });

  expect(endpoint.requests).toEqual(["/", "/index.bundle"]);
  expect(progress).toHaveLength(4);
  expect(progress[0]).toMatch(/^phase=document status=start /);
  expect(progress[1]).toMatch(
    /^phase=document status=complete .* http-status=200 bytes=63 phase-elapsed-ms=\d+ total-elapsed-ms=\d+$/,
  );
  expect(progress[2]).toMatch(/^phase=bundle status=start .*index\.bundle\?platform=web/);
  expect(progress[3]).toMatch(
    /^phase=bundle status=complete .* http-status=200 bytes=15 phase-elapsed-ms=\d+ total-elapsed-ms=\d+$/,
  );
});

test("Metro warmup timeout identifies the phase, URL, process state, and recent output", async () => {
  endpoint = await MetroPort.listen();
  endpoint.serveWarmableDocument();
  endpoint.delayBundle(100);

  await expect(
    warmMetro(endpoint.port, {
      timeoutMs: 20,
      getRecentOutput: () => "[stdout] Bundling JavaScript",
    }),
  ).rejects.toThrow(
    new RegExp(
      `phase=bundle url=http://127\\.0\\.0\\.1:${endpoint.port}/index\\.bundle\\?platform=web phase-elapsed-ms=\\d+ total-elapsed-ms=\\d+ timeout-ms=20 process=unavailable cause=TimeoutError:[\\s\\S]*Recent output:\\n\\[stdout\\] Bundling JavaScript`,
    ),
  );
});
