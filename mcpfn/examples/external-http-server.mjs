import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

const MAX_REQUEST_BYTES = 1_048_576;
const apiKey = process.env.MCPFN_EXTERNAL_API_KEY;
if (!apiKey) throw new Error("MCPFN_EXTERNAL_API_KEY is required");

const sessions = new Map();
const httpServer = createServer(async (incoming, outgoing) => {
  const url = new URL(
    incoming.url ?? "/",
    `http://${incoming.headers.host ?? "127.0.0.1"}`,
  );
  if (url.pathname !== "/mcp") {
    outgoing.writeHead(404).end("Not found");
    return;
  }
  if (!matchesSecret(incoming.headers["x-api-key"], apiKey)) {
    // Reject before reading any request body.
    outgoing.writeHead(401, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "www-authenticate": 'ApiKey realm="mcpfn-external-fixture"',
    }).end(JSON.stringify({ error: "invalid_credential" }));
    return;
  }
  const declaredLength = Number(incoming.headers["content-length"] ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    outgoing.writeHead(413).end("Request body too large");
    return;
  }
  try {
    const request = await toWebRequest(incoming, url);
    const handled = await handleMcpRequest(request);
    try {
      await sendWebResponse(outgoing, handled.response);
    } finally {
      await handled.release?.();
    }
  } catch (error) {
    if (String(error).includes("Request body too large")) {
      outgoing.writeHead(413).end("Request body too large");
    } else if (outgoing.headersSent) {
      outgoing.destroy();
    } else {
      outgoing.writeHead(500).end("Internal Server Error");
    }
  }
});

await new Promise((resolve, reject) => {
  httpServer.once("error", reject);
  httpServer.listen(0, "127.0.0.1", resolve);
});
const address = httpServer.address();
if (!address || typeof address === "string") {
  throw new Error("External MCP fixture did not bind a TCP port");
}
process.stdout.write(`http://127.0.0.1:${address.port}/mcp\n`);

async function handleMcpRequest(request) {
  const sessionId = request.headers.get("mcp-session-id");
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      return {
        response: Response.json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found" },
          id: null,
        }, { status: 404 }),
      };
    }
    return { response: await session.transport.handleRequest(request) };
  }

  const mcp = new McpServer(
    { name: "official-sdk-external-fixture", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  mcp.registerTool(
    "external_identity",
    { description: "Return proof from a non-McpFn-native MCP server." },
    async () => ({
      content: [{ type: "text", text: JSON.stringify({ authenticated: true }) }],
      structuredContent: { authenticated: true },
    }),
  );
  let initializedSessionId;
  let released = false;
  let transport;
  const release = async () => {
    if (released) return;
    released = true;
    if (initializedSessionId) sessions.delete(initializedSessionId);
    await mcp.close();
  };
  transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true,
    onsessioninitialized: async (id) => {
      initializedSessionId = id;
      sessions.set(id, { mcp, transport, release });
    },
    onsessionclosed: release,
  });
  try {
    await mcp.connect(transport);
    const response = await transport.handleRequest(request);
    return initializedSessionId ? { response } : { response, release };
  } catch (error) {
    await release();
    throw error;
  }
}

async function toWebRequest(incoming, url) {
  const chunks = [];
  let size = 0;
  for await (const chunk of incoming) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks);
  return new Request(url, {
    method: incoming.method,
    headers: new Headers(Object.entries(incoming.headers).flatMap(([name, value]) =>
      Array.isArray(value)
        ? value.map((entry) => [name, entry])
        : value === undefined ? [] : [[name, value]],
    )),
    ...(body.length ? { body } : {}),
  });
}

async function sendWebResponse(outgoing, response) {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    outgoing.end();
    return;
  }
  const reader = response.body.getReader();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    outgoing.write(Buffer.from(chunk.value));
  }
  outgoing.end();
}

function matchesSecret(received, expected) {
  if (Array.isArray(received) || typeof received !== "string") return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function shutdown() {
  await Promise.allSettled([...sessions.values()].map((session) => session.release()));
  await new Promise((resolve) => httpServer.close(resolve));
}

process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
