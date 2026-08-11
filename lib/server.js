/**
 * MCP stdio shim for the Lumine editor.
 *
 * Claude CLI spawns this as a standalone process and speaks MCP over
 * newline-delimited JSON on stdio. Every message is forwarded verbatim to the
 * bridge running inside Lumine, which owns the protocol — the same endpoint an
 * HTTP-speaking client would use. What is left here is the framing, finding
 * the editor, and the error to show when there is no editor to find.
 *
 * The bridge picks a port at startup and a token at every startup, so neither
 * can be baked into this process's configuration. It finds them instead by
 * reading the endpoint registry the bridge publishes, and it resolves late —
 * on the first message, and again after a failure — so that closing and
 * reopening the editor does not strand a host that was configured hours ago.
 *
 * Environment variables, all optional and all overriding the registry:
 *   LUMINE_BRIDGE_PORT  - Port of the bridge server
 *   LUMINE_BRIDGE_HOST  - Host of the bridge server (default: 127.0.0.1)
 *   LUMINE_BRIDGE_TOKEN - Token to present; only honoured with an explicit port
 */

const readline = require("readline");
const endpoint = require("./endpoint");

const ENV_PORT = process.env.LUMINE_BRIDGE_PORT
  ? parseInt(process.env.LUMINE_BRIDGE_PORT, 10)
  : null;
const ENV_HOST = process.env.LUMINE_BRIDGE_HOST || null;
const ENV_TOKEN = process.env.LUMINE_BRIDGE_TOKEN || null;

const UNAVAILABLE =
  "No Lumine bridge is running. Make sure Lumine is open with the lumine-mcp " +
  "package activated, and that its bridge is started — the `Lumine MCP: Status` " +
  "command reports it.";

// Handed out by the bridge when the session is initialized, and echoed back on
// everything after that.
let sessionId = null;

// Agreed with the bridge during initialize, and reported on every request from
// then on, as the transport requires.
let protocolVersion = null;

// Which bridge this process is talking to. Resolved on demand and dropped the
// moment it stops answering, so the next message looks for the editor again.
let target = null;

/**
 * Send a JSON-RPC message to stdout
 */
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

/**
 * Is this endpoint the bridge that published it, and is it still up?
 *
 * The registry is a directory of files, and a file outlives the editor that
 * wrote it whenever the editor was killed rather than closed. /health is the
 * one route that answers without a token, and exists to settle this.
 */
async function isAlive(host, port) {
  try {
    const response = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Find a bridge to talk to. An explicit port and token are taken at their
 * word; anything else is looked up and confirmed before it is used.
 */
async function resolveTarget() {
  if (ENV_PORT && ENV_TOKEN) {
    return { host: ENV_HOST || "127.0.0.1", port: ENV_PORT, token: ENV_TOKEN };
  }

  const candidates = endpoint.list().filter((entry) => !ENV_PORT || entry.port === ENV_PORT);
  for (const candidate of candidates) {
    const host = ENV_HOST || candidate.host || "127.0.0.1";
    if (await isAlive(host, candidate.port)) {
      return { host, port: candidate.port, token: candidate.token };
    }
  }

  return null;
}

/**
 * Pass a JSON-RPC message to the bridge and return its answer, or null when
 * the bridge accepted it without one.
 */
async function forward(body) {
  target ??= await resolveTarget();
  if (!target) throw new Error(UNAVAILABLE);

  const headers = {
    "Content-Type": "application/json",
    // The transport requires a client to accept both, whichever it gets.
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${target.token}`,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  if (protocolVersion) headers["MCP-Protocol-Version"] = protocolVersion;

  const response = await fetch(`http://${target.host}:${target.port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  // The session belongs to the bridge that issued it, and a bridge that has
  // forgotten it says so with a 404. Dropping it here is what makes the next
  // initialize a new session rather than a retry of a dead one; the bridge's
  // own error response is what tells the host to send that initialize.
  if (response.status === 404) sessionId = null;

  const issued = response.headers.get("mcp-session-id");
  if (issued) sessionId = issued;

  // 202 is the bridge acknowledging a notification: nothing to answer.
  if (response.status === 202) return null;

  const answer = await response.json();
  const negotiated = answer?.result?.protocolVersion;
  if (negotiated) protocolVersion = negotiated;
  return answer;
}

/**
 * Forward, and on a connection failure look for the editor once more before
 * giving up: the usual cause is an editor that was restarted onto a different
 * port since the last message. Only a failure to reach the bridge is retried —
 * anything the bridge itself answered is the answer.
 */
async function forwardWithRetry(body) {
  try {
    return await forward(body);
  } catch (error) {
    if (!target) throw error;
    target = null;
    sessionId = null;
    protocolVersion = null;
    return forward(body);
  }
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
    const response = await forwardWithRetry(body);
    if (response !== null) send(response);
  } catch (error) {
    // The editor is closed, or closed mid-call. Anything that asked a question
    // is told so rather than left waiting for an answer that cannot come.
    const id = Array.isArray(body) ? null : body.id;
    if (id === undefined) return;
    send({
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code: -32603, message: error.message || UNAVAILABLE },
    });
  }
});

// The bridge holds a session until it is told to let go, and this process is
// the only thing that knows this one has ended.
rl.on("close", async () => {
  if (!sessionId || !target) return;
  try {
    await fetch(`http://${target.host}:${target.port}/mcp`, {
      method: "DELETE",
      headers: {
        "Mcp-Session-Id": sessionId,
        Authorization: `Bearer ${target.token}`,
      },
    });
  } catch {
    /* The editor is already gone, and took the session with it. */
  }
});

// Claude CLI closing its end while a write is in flight is how this process
// normally ends; there is nobody left to report it to.
// eslint-disable-next-line n/no-process-exit -- throwing needs a stdout to land on
process.stdout.on("error", () => process.exit(0));

console.error("[lumine-mcp] MCP server started");
