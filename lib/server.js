/**
 * MCP stdio shim for the Lumine editor.
 *
 * The shim owns the host-facing MCP session. It starts disconnected and
 * offers one local tool, ConnectToLumine, which selects a bridge by port and
 * waits for that window's user to approve the connection. Once connected, it
 * proxies the bridge's tools and server-initiated notifications without ever
 * exposing the bearer token to the host.
 */

const readline = require("readline");
const { PROTOCOL_VERSION, initializeResult } = require("./protocol");

const HOST = "127.0.0.1";
const CONNECT_TOOL_NAME = "ConnectToLumine";
const AUTHORIZE_TIMEOUT = 65_000;

function validPort(value) {
  const port = typeof value === "number" ? value : Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

const ENV_PORT = validPort(process.env.LUMINE_BRIDGE_PORT);

let hostInitializeParams = null;
let hostInitialized = false;
let target = null;
let connecting = false;
let connectionAttemptAbort = null;
let closing = false;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function jsonRpcResponse(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

function toolResponse(id, text, isError = false) {
  return jsonRpcResponse(id, {
    content: [{ type: "text", text }],
    isError,
  });
}

function connectTool() {
  const properties = {
    port: {
      type: "integer",
      minimum: 1024,
      maximum: 65535,
      description: ENV_PORT
        ? `The Lumine MCP port. Omit it to use ${ENV_PORT} from LUMINE_BRIDGE_PORT.`
        : "The port reported by Lumine MCP: Status in the target window.",
    },
  };
  return {
    name: CONNECT_TOOL_NAME,
    title: "Connect to Lumine",
    description:
      "Connect this MCP session to a specific Lumine window. The user must approve the connection in that window.",
    inputSchema: {
      type: "object",
      properties,
      required: ENV_PORT ? [] : ["port"],
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
  };
}

function disconnectedToolsList(id) {
  return jsonRpcResponse(id, { tools: [connectTool()] });
}

function notifyToolsListChanged() {
  if (closing) return;
  setImmediate(() => {
    if (!closing) {
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
  });
}

function clientName() {
  const name = hostInitializeParams?.clientInfo?.name;
  return typeof name === "string" && name.trim() ? name.trim() : "Unknown MCP client";
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

class TargetUnavailableError extends Error {}

async function authorize(port, signal) {
  let response;
  try {
    response = await fetch(`http://${HOST}:${port}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientName: clientName() }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(AUTHORIZE_TIMEOUT)]),
    });
  } catch (error) {
    throw new Error(`Could not reach Lumine on port ${port}: ${error.message}`, { cause: error });
  }

  const body = await responseJson(response);
  if (!response.ok) {
    throw new Error(body?.error || `Lumine refused the connection (${response.status})`);
  }
  if (typeof body?.token !== "string" || !body.token) {
    throw new Error("Lumine approved the connection but returned no token");
  }
  return body.token;
}

async function postToBridge(connection, body, { initializing = false } = {}) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${connection.token}`,
  };
  if (!initializing && connection.sessionId) {
    headers["Mcp-Session-Id"] = connection.sessionId;
  }
  if (!initializing && connection.protocolVersion) {
    headers["MCP-Protocol-Version"] = connection.protocolVersion;
  }

  let response;
  try {
    response = await fetch(`http://${HOST}:${connection.port}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new TargetUnavailableError(error.message);
  }

  if (response.status === 401 || response.status === 404 || response.status === 503) {
    throw new TargetUnavailableError(`Lumine bridge returned ${response.status}`);
  }

  const issued = response.headers.get("mcp-session-id");
  if (issued) connection.sessionId = issued;
  if (response.status === 202) return null;

  const answer = await responseJson(response);
  if (answer === null) {
    if (!response.ok) {
      throw new Error(`Lumine bridge returned ${response.status}`);
    }
    throw new Error("Lumine bridge returned an invalid response");
  }
  return answer;
}

async function initializeConnection(connection) {
  const params = hostInitializeParams || {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "lumine-mcp", version: "1.0.0" },
  };
  const answer = await postToBridge(
    connection,
    {
      jsonrpc: "2.0",
      id: "lumine-mcp-backend-initialize",
      method: "initialize",
      params,
    },
    { initializing: true },
  );
  if (answer?.error) {
    throw new Error(answer.error.message || "Lumine bridge initialization failed");
  }
  if (!connection.sessionId) {
    throw new Error("Lumine bridge returned no MCP session");
  }
  connection.protocolVersion = answer?.result?.protocolVersion;
  await postToBridge(connection, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
}

async function closeConnection(connection, { terminate = true } = {}) {
  if (!connection) return;
  connection.closing = true;
  connection.streamAbort?.abort();
  if (!terminate || !connection.sessionId) return;
  try {
    await fetch(`http://${HOST}:${connection.port}/mcp`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "Mcp-Session-Id": connection.sessionId,
      },
    });
  } catch {
    /* The target is already gone. */
  }
}

function loseConnection(connection) {
  if (target !== connection) return;
  target = null;
  closeConnection(connection, { terminate: false });
  notifyToolsListChanged();
}

async function openEventStream(connection) {
  connection.streamAbort = new AbortController();
  try {
    const response = await fetch(`http://${HOST}:${connection.port}/mcp`, {
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${connection.token}`,
        "Mcp-Session-Id": connection.sessionId,
        ...(connection.protocolVersion
          ? { "MCP-Protocol-Version": connection.protocolVersion }
          : {}),
      },
      signal: connection.streamAbort.signal,
    });
    if (!response.ok || !response.body) {
      throw new TargetUnavailableError(`Lumine event stream returned ${response.status}`);
    }

    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            send(JSON.parse(line.slice(5).trim()));
          } catch {
            /* Ignore malformed or non-message frames. */
          }
        }
      }
    }
    if (!connection.closing) loseConnection(connection);
  } catch {
    if (!connection.closing) loseConnection(connection);
  }
}

async function connect(port) {
  if (target?.port === port) {
    return `Already connected to Lumine on port ${port}.`;
  }
  if (connecting) throw new Error("Another Lumine connection is already awaiting approval");

  connecting = true;
  const abort = new AbortController();
  connectionAttemptAbort = abort;
  let candidate;
  try {
    const token = await authorize(port, abort.signal);
    candidate = {
      port,
      token,
      sessionId: null,
      protocolVersion: null,
      streamAbort: null,
      closing: false,
    };
    await initializeConnection(candidate);

    const previous = target;
    target = candidate;
    openEventStream(candidate);
    await closeConnection(previous);
    notifyToolsListChanged();
    return previous
      ? `Switched the MCP session to Lumine on port ${port}.`
      : `Connected the MCP session to Lumine on port ${port}.`;
  } catch (error) {
    await closeConnection(candidate);
    throw error;
  } finally {
    if (connectionAttemptAbort === abort) connectionAttemptAbort = null;
    connecting = false;
  }
}

async function forwardToTarget(message) {
  const connection = target;
  if (!connection) throw new Error("Connect to a Lumine window first");
  try {
    return await postToBridge(connection, message);
  } catch (error) {
    if (error instanceof TargetUnavailableError) {
      loseConnection(connection);
      throw new Error(`The Lumine window on port ${connection.port} is no longer available`, {
        cause: error,
      });
    }
    throw error;
  }
}

async function handleToolsList(id) {
  if (!target) return disconnectedToolsList(id);
  try {
    const answer = await forwardToTarget({ jsonrpc: "2.0", id, method: "tools/list" });
    if (answer?.result?.tools) {
      answer.result.tools = [connectTool(), ...answer.result.tools];
    }
    return answer;
  } catch {
    return disconnectedToolsList(id);
  }
}

async function handleToolsCall(id, params) {
  if (params?.name === CONNECT_TOOL_NAME) {
    const port = validPort(params.arguments?.port ?? ENV_PORT);
    if (!port) {
      return toolResponse(
        id,
        "Provide the port reported by Lumine MCP: Status, or launch this server with LUMINE_BRIDGE_PORT.",
        true,
      );
    }
    try {
      return toolResponse(id, await connect(port));
    } catch (error) {
      return toolResponse(id, error.message || "Could not connect to Lumine", true);
    }
  }

  if (!target) return toolResponse(id, "Connect to a Lumine window first.", true);
  try {
    return await forwardToTarget({ jsonrpc: "2.0", id, method: "tools/call", params });
  } catch (error) {
    return toolResponse(id, error.message, true);
  }
}

async function handleMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return jsonRpcError(null, -32600, "Invalid Request");
  }
  const { jsonrpc, id, method, params = {} } = message;
  if (jsonrpc !== "2.0") return jsonRpcError(id, -32600, "Invalid Request: must be JSON-RPC 2.0");

  switch (method) {
    case "initialize": {
      hostInitializeParams = params;
      hostInitialized = false;
      if (target) {
        const previous = target;
        target = null;
        await closeConnection(previous);
      }
      return jsonRpcResponse(id, initializeResult(params));
    }
    case "notifications/initialized":
      hostInitialized = true;
      return null;
    case "ping":
      return jsonRpcResponse(id, {});
    case "tools/list":
      if (!hostInitializeParams) return jsonRpcError(id, -32002, "Initialize first");
      return handleToolsList(id);
    case "tools/call":
      if (!hostInitializeParams || !hostInitialized) {
        return jsonRpcError(id, -32002, "Initialize first");
      }
      return handleToolsCall(id, params);
    default:
      if (id === undefined || id === null) {
        if (target) {
          try {
            await forwardToTarget(message);
          } catch {
            /* Notifications have no error channel. */
          }
        }
        return null;
      }
      if (!target) return jsonRpcError(id, -32601, `Method not found: ${method}`);
      try {
        return await forwardToTarget(message);
      } catch (error) {
        return jsonRpcError(id, -32603, error.message);
      }
  }
}

async function handleBody(body) {
  if (!Array.isArray(body)) return handleMessage(body);
  if (body.length === 0) return jsonRpcError(null, -32600, "Invalid Request");
  const responses = [];
  for (const message of body) {
    const response = await handleMessage(message);
    if (response !== null) responses.push(response);
  }
  return responses.length ? responses : null;
}

const rl = readline.createInterface({ input: process.stdin });
let inputQueue = Promise.resolve();

rl.on("line", (line) => {
  inputQueue = inputQueue.then(async () => {
    if (!line.trim()) return;
    let body;
    try {
      body = JSON.parse(line);
    } catch {
      send(jsonRpcError(null, -32700, "Parse error"));
      return;
    }

    try {
      const response = await handleBody(body);
      if (response !== null) send(response);
    } catch (error) {
      const id = Array.isArray(body) ? null : body?.id;
      if (id !== undefined) send(jsonRpcError(id, -32603, error.message));
    }
  });
});

rl.on("close", () => {
  closing = true;
  connectionAttemptAbort?.abort();
  inputQueue.finally(async () => {
    const connection = target;
    target = null;
    await closeConnection(connection);
  });
});

// The host closing stdout while a write is in flight is a normal shutdown.
// eslint-disable-next-line n/no-process-exit -- there is nobody left to report to
process.stdout.on("error", () => process.exit(0));

console.error("[lumine-mcp] MCP server started");
