/**
 * MCP stdio shim for the Lumine editor.
 *
 * Claude CLI spawns this as a standalone process and speaks MCP over
 * newline-delimited JSON on stdio. Every message is forwarded verbatim to the
 * bridge running inside Lumine, which owns the protocol — the same endpoint an
 * HTTP-speaking client would use. What is left here is the framing and the
 * error to show when the editor is not running.
 *
 * Environment variables:
 *   LUMINE_BRIDGE_PORT - Port of the bridge server (default: 3000)
 *   LUMINE_BRIDGE_HOST - Host of the bridge server (default: 127.0.0.1)
 */

const readline = require("readline");

const BRIDGE_PORT = parseInt(process.env.LUMINE_BRIDGE_PORT || "3000", 10);
const BRIDGE_HOST = process.env.LUMINE_BRIDGE_HOST || "127.0.0.1";
const ENDPOINT = `http://${BRIDGE_HOST}:${BRIDGE_PORT}/mcp`;

const UNAVAILABLE =
  `Lumine bridge not available at http://${BRIDGE_HOST}:${BRIDGE_PORT}. ` +
  "Make sure Lumine is running with the lumine-mcp package activated.";

// Handed out by the bridge when the session is initialized, and echoed back on
// everything after that.
let sessionId = null;

/**
 * Send a JSON-RPC message to stdout
 */
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

/**
 * Pass a JSON-RPC message to the bridge and return its answer, or null when
 * the bridge accepted it without one.
 */
async function forward(body) {
  const headers = { "Content-Type": "application/json" };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const issued = response.headers.get("mcp-session-id");
  if (issued) sessionId = issued;

  // 202 is the bridge acknowledging a notification: nothing to answer.
  if (response.status === 202) return null;
  return response.json();
}

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  if (!line.trim()) return;

  let body;
  try {
    body = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }

  try {
    const response = await forward(body);
    if (response !== null) send(response);
  } catch {
    // The editor is closed, or closed mid-call. Anything that asked a question
    // is told so rather than left waiting for an answer that cannot come.
    const id = Array.isArray(body) ? null : body.id;
    if (id === undefined) return;
    send({ jsonrpc: "2.0", id: id ?? null, error: { code: -32603, message: UNAVAILABLE } });
  }
});

// The bridge holds a session until it is told to let go, and this process is
// the only thing that knows this one has ended.
rl.on("close", async () => {
  if (!sessionId) return;
  try {
    await fetch(ENDPOINT, { method: "DELETE", headers: { "Mcp-Session-Id": sessionId } });
  } catch {
    /* The editor is already gone, and took the session with it. */
  }
});

// Claude CLI closing its end while a write is in flight is how this process
// normally ends; there is nobody left to report it to.
// eslint-disable-next-line n/no-process-exit -- throwing needs a stdout to land on
process.stdout.on("error", () => process.exit(0));

console.error("[lumine-mcp] MCP server started");
