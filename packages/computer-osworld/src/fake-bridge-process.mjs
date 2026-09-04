import { createServer } from "node:http";

// Process-level Fake DesktopEnv: it exposes the same RPC contract without
// importing OSWorld or starting a VM.

const mode = process.env.FAKE_BRIDGE_MODE ?? "normal";
const expectedToken = process.env.FAKE_BRIDGE_TOKEN ?? "";
const capture = {
  mediaType: "image/png",
  dataBase64: "AQID",
  width: 800,
  height: 600,
  capturedAt: "2026-09-04T00:00:00.000Z",
};

const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/rpc") {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  if (expectedToken && request.headers.authorization !== `Bearer ${expectedToken}`) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ requestId: input.requestId, ok: false, error: { code: "UNAUTHORIZED", message: "invalid bridge token" } }));
    return;
  }
  if (mode === "bad-envelope") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ requestId: "wrong-request", ok: true, result: {} }));
    return;
  }
  let result;
  switch (input.method) {
    case "health": result = { status: "ok", protocolVersion: mode === "bad-version" ? "999" : "1" }; break;
    case "environment.reset": result = { taskId: input.params.taskId, instruction: "fake task" }; break;
    case "computer.describe": result = { viewport: { width: 800, height: 600, coordinateSpace: "physical" }, capabilities: { screenshot: true, pointer: true, keyboard: true } }; break;
    case "computer.observe": result = mode === "bad-capture" ? { ...capture, mediaType: "image/jpeg" } : capture; break;
    case "computer.execute": result = { status: "completed", postActionCapture: capture }; break;
    case "environment.evaluate": result = { score: 1 }; break;
    case "environment.close": result = { closed: true }; break;
    default:
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ requestId: input.requestId, ok: false, error: { code: "UNKNOWN_METHOD", message: input.method } }));
      return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ requestId: input.requestId, ok: true, result }));
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to determine fake bridge port");
  process.stdout.write(`READY ${address.port}\n`);
});

const shutdown = () => server.close(() => process.exit(0));
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
