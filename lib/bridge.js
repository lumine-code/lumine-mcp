/**
 * HTTP Bridge server for Lumine MCP
 * Runs inside Lumine and provides direct access to lumine APIs
 */

const crypto = require("crypto");
const http = require("http");
const { URL } = require("url");
const { CompositeDisposable } = require("lumine");
const { getToolsList, executeTool: executeBuiltinTool, getToolByName } = require("./tools");
const { createLogger } = require("./log");
const endpoint = require("./endpoint");
const { name: SERVER_NAME, version: SERVER_VERSION } = require("../package.json");

const log = createLogger("Bridge");

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "127.0.0.1";

// Newest first. A client naming one of these is answered in its own version;
// one naming anything else is answered in the newest and decides for itself
// whether to carry on. A client that sends no MCP-Protocol-Version header at
// all is 2025-03-26 by the transport's own back-compatibility rule, which is
// why that version stays on the list.
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const ASSUMED_PROTOCOL_VERSION = "2025-03-26";

// A session nobody has touched for this long belongs to an editor session that
// ended without saying so. Pruned when the next one is created.
const SESSION_TTL = 24 * 60 * 60 * 1000;

// Session storage for MCP connections
const sessions = new Map();

// External tools registered by other packages
let externalToolsMap = new Map();

/**
 * Set external tools from main.js
 * @param {Map} toolsMap - Map of tool name to tool definition
 */
function setExternalTools(toolsMap) {
  externalToolsMap = toolsMap;
  log.debug(`External tools updated: ${Array.from(toolsMap.keys()).join(", ") || "(none)"}`);
  notifyToolsListChanged();
}

/**
 * Check if a tool is enabled based on listMode and toolList
 *
 * A greenlist names the tools that are on, so an empty one is not a greenlist
 * that has been forgotten — it is nobody allowed. Reading it as everybody
 * allowed made "disable all" enable all, and left the toggle list drawing a
 * cross beside every tool the bridge was serving.
 */
function isToolEnabled(toolName) {
  const mode = lumine.config.get("lumine-mcp.listMode") || "blacklist";
  const list = lumine.config.get("lumine-mcp.toolList") || [];
  return mode === "greenlist" ? list.includes(toolName) : !list.includes(toolName);
}

/**
 * Execute a tool call (builtin or external)
 */
async function executeTool(toolName, args) {
  // Resolved before it is judged, so an unknown name is reported as unknown
  // rather than as something the user could go and switch on.
  const isBuiltin = Boolean(getToolByName(toolName));
  if (!isBuiltin && !externalToolsMap.has(toolName)) {
    return { success: false, error: `Unknown tool: ${toolName}` };
  }

  if (!isToolEnabled(toolName)) {
    return {
      success: false,
      error: `Tool is disabled: ${toolName}. Enable it from the editor's Lumine MCP: Toggle Tools list.`,
    };
  }

  log.debug(`Executing tool: ${toolName}`, { args });
  const start = performance.now();

  let result;
  if (isBuiltin) {
    result = await executeBuiltinTool(toolName, args);
  } else {
    const tool = externalToolsMap.get(toolName);
    try {
      const data = await tool.execute(args);
      result = { success: true, data };
    } catch (error) {
      result = { success: false, error: error.message || String(error) };
    }
  }

  const duration = (performance.now() - start).toFixed(2);
  if (result.success) {
    log.debug(`Tool ${toolName} completed in ${duration}ms`, {
      data: result.data,
    });
  } else {
    log.debug(`Tool ${toolName} failed in ${duration}ms`, {
      error: result.error,
    });
  }

  return result;
}

// ============================================================================
// HTTP Server
// ============================================================================

/**
 * Parse JSON body from request
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Send JSON response
 */
function sendJson(res, data, statusCode = 200, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

// ============================================================================
// Access control
// ============================================================================

/**
 * Compare two tokens without leaking where they diverge through timing.
 */
function tokenMatches(expected, presented) {
  if (typeof presented !== "string") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * A browser is never a legitimate caller here.
 *
 * The bridge listens on the loopback interface, which every page in every
 * browser on this machine can also reach; a request carrying an Origin came
 * from one of those pages, and the only editor it can be after is somebody
 * else's. The MCP specification requires refusing them for exactly this
 * reason — without it, DNS rebinding turns a visited web page into a client.
 */
function refuseBrowsers(req, res) {
  if (req.headers.origin === undefined) return false;
  log.warn(`Refused a request carrying Origin: ${req.headers.origin}`);
  sendJson(res, { error: "Forbidden: browser origins are not accepted" }, 403);
  return true;
}

/**
 * Everything past /health has to present the token this bridge published.
 */
function refuseUntrusted(req, res, token) {
  const header = req.headers.authorization || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (tokenMatches(token, presented)) return false;
  sendJson(
    res,
    { error: "Unauthorized: present the bridge token as `Authorization: Bearer <token>`" },
    401,
  );
  return true;
}

// ============================================================================
// MCP Protocol Handlers
// ============================================================================

/**
 * Generate a unique session ID
 */
function generateSessionId() {
  return crypto.randomUUID();
}

/**
 * Create JSON-RPC response
 */
function jsonRpcResponse(id, result) {
  return { jsonrpc: "2.0", id, result };
}

/**
 * Create JSON-RPC error response
 */
function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

/**
 * Drop sessions whose client went away without terminating them. Without this
 * the map is append-only for the life of the window.
 */
function pruneSessions(now) {
  for (const [id, session] of sessions) {
    if (now - session.lastSeenAt > SESSION_TTL) {
      sessions.delete(id);
      log.debug(`MCP session expired: ${id}`);
    }
  }
}

/**
 * Handle MCP initialize request
 */
function handleInitialize(id, params) {
  const now = Date.now();
  pruneSessions(now);

  // The specification is exact here: answer in the client's own version when
  // it is one we speak, and in ours when it is not. Answering in ours either
  // way told a client on an older version that we had agreed to its request
  // when we had not, and the correct response to that is to hang up.
  const requested = params.protocolVersion;
  const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : PROTOCOL_VERSION;
  if (requested && requested !== protocolVersion) {
    log.debug(`Client asked for protocol ${requested}; answering with ${protocolVersion}`);
  }

  const sessionId = generateSessionId();
  sessions.set(sessionId, {
    initialized: true,
    protocolVersion,
    clientInfo: params.clientInfo,
    createdAt: now,
    lastSeenAt: now,
    // Open SSE streams belonging to this session, over which the bridge
    // reaches the client rather than answering it.
    streams: new Set(),
  });

  log.debug(`MCP session initialized: ${sessionId}`);

  return {
    response: jsonRpcResponse(id, {
      protocolVersion,
      capabilities: {
        tools: { listChanged: true },
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
    }),
    sessionId,
  };
}

// ============================================================================
// Server-initiated messages
// ============================================================================

/**
 * Push a notification to every client listening on an SSE stream.
 *
 * A client that never opened one simply does not hear it, which is the whole
 * of the degradation: it keeps whatever tool list it last fetched.
 */
function notifyAll(message) {
  const frame = `data: ${JSON.stringify(message)}\n\n`;
  for (const session of sessions.values()) {
    for (const stream of session.streams) {
      try {
        stream.write(frame);
      } catch {
        session.streams.delete(stream);
      }
    }
  }
}

/**
 * The tool list is not fixed: packages register and withdraw tools as they
 * activate, and the user turns tools on and off from the toggle list. Saying
 * so is what makes `listChanged: true` true.
 */
function notifyToolsListChanged() {
  notifyAll({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
}

/**
 * How many clients are currently listening. A caller that has just handed a
 * client its session has not yet been reached by the GET that follows it, and
 * this is how it waits for that to land.
 */
function openStreamCount() {
  let count = 0;
  for (const session of sessions.values()) count += session.streams.size;
  return count;
}

/**
 * Every tool a caller may reach, built-in and registered alike.
 *
 * A name is listed once. An external tool cannot shadow a built-in — execution
 * resolves the built-in first, so listing both advertised a tool that could
 * never be called under a name that already meant something else.
 */
function listEnabledTools() {
  const tools = getToolsList();
  const taken = new Set(tools.map((tool) => tool.name));

  for (const tool of externalToolsMap.values()) {
    if (taken.has(tool.name)) {
      log.warn(`External tool ${tool.name} is shadowed by a builtin of the same name; not listed`);
      continue;
    }
    taken.add(tool.name);
    tools.push({
      name: tool.name,
      description: tool.description || "",
      inputSchema: tool.inputSchema || {
        type: "object",
        properties: {},
        required: [],
      },
      annotations: tool.annotations,
    });
  }

  return tools.filter((tool) => isToolEnabled(tool.name));
}

/**
 * Handle MCP tools/list request
 */
function handleToolsList(id) {
  return jsonRpcResponse(id, { tools: listEnabledTools() });
}

/**
 * Handle MCP tools/call request
 */
async function handleToolsCall(id, params) {
  const { name, arguments: args = {} } = params;

  if (!name) {
    return jsonRpcError(id, -32602, "Invalid params: missing tool name");
  }

  const result = await executeTool(name, args);

  if (result.success) {
    return jsonRpcResponse(id, {
      content: [
        {
          type: "text",
          text: JSON.stringify(result.data, null, 2),
        },
      ],
      isError: false,
    });
  } else {
    return jsonRpcResponse(id, {
      content: [
        {
          type: "text",
          text: result.error || "Tool execution failed",
        },
      ],
      isError: true,
    });
  }
}

/**
 * A request the client cannot have a session for yet, or that the lifecycle
 * allows before one exists. Everything else has to name the session it belongs
 * to. Notifications are exempt whatever they say: there is no way to answer
 * one, so refusing it can only be silent.
 */
function requiresSession(message) {
  if (!message || message.id === undefined || message.id === null) return false;
  return message.method !== "initialize" && message.method !== "ping";
}

/**
 * Handle MCP JSON-RPC request
 */
async function handleMcpRequest(body, sessionId) {
  const { jsonrpc, id, method, params = {} } = body;

  if (jsonrpc !== "2.0") {
    return {
      response: jsonRpcError(id, -32600, "Invalid Request: must be JSON-RPC 2.0"),
    };
  }

  const session = sessionId ? sessions.get(sessionId) : null;
  if (session) session.lastSeenAt = Date.now();

  log.debug(`MCP request: ${method}`, { id, params });

  switch (method) {
    case "initialize":
      return handleInitialize(id, params);

    case "notifications/initialized":
      // Client notification that initialization is complete
      return { response: null, statusCode: 202 };

    case "tools/list":
      return { response: handleToolsList(id) };

    case "tools/call":
      return { response: await handleToolsCall(id, params) };

    case "ping":
      return { response: jsonRpcResponse(id, {}) };

    default:
      return {
        response: jsonRpcError(id, -32601, `Method not found: ${method}`),
      };
  }
}

/**
 * Handle POST /mcp endpoint
 */
async function handleMcpEndpoint(req, res) {
  const sessionId = req.headers["mcp-session-id"];

  // Parse request body
  let body;
  try {
    body = await parseBody(req);
  } catch {
    sendJson(res, jsonRpcError(null, -32700, "Parse error: invalid JSON"), 400);
    return;
  }

  const messages = Array.isArray(body) ? body : [body];

  // A session is the client's claim to have been through initialize. Checked
  // here rather than per message, so a batch is accepted or refused whole.
  if (messages.some(requiresSession)) {
    if (!sessionId) {
      sendJson(res, jsonRpcError(null, -32600, "Missing Mcp-Session-Id: initialize first"), 400);
      return;
    }
    if (!sessions.has(sessionId)) {
      // 404 is what tells a client to start over with a fresh initialize.
      sendJson(res, jsonRpcError(null, -32600, "Unknown or terminated session"), 404);
      return;
    }
  }

  // Handle batch requests (JSON-RPC 2.0 batching)
  if (Array.isArray(body)) {
    const results = await Promise.all(body.map((request) => handleMcpRequest(request, sessionId)));
    // Filter out null responses (notifications) and extract response objects
    const responses = results.filter((r) => r.response !== null).map((r) => r.response);
    // If all were notifications, return 202
    if (responses.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }
    // A batch may carry the initialize that opened the session, and the client
    // has no other way to learn the id it was handed.
    const issued = results.find((r) => r.sessionId)?.sessionId;
    sendJson(res, responses, 200, issued ? { "Mcp-Session-Id": issued } : {});
    return;
  }

  // Handle single request
  const result = await handleMcpRequest(body, sessionId);

  // If no response needed (notification), return 202
  if (result.response === null) {
    res.writeHead(202);
    res.end();
    return;
  }

  // Build response headers
  const headers = {};
  if (result.sessionId) {
    headers["Mcp-Session-Id"] = result.sessionId;
  }

  sendJson(res, result.response, 200, headers);
}

/**
 * Handle GET /mcp - the stream the bridge speaks to the client over.
 *
 * Nothing is answered here; this carries only what the bridge starts, which
 * today is one notification saying the tool list has moved.
 */
function handleEventStream(req, res, sessionId) {
  const session = sessionId ? sessions.get(sessionId) : null;
  if (!session) {
    sendJson(res, jsonRpcError(null, -32600, "Unknown or terminated session"), 404);
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-store",
    Connection: "keep-alive",
  });
  // A comment frame, so the client sees the stream is open before anything
  // has happened on it.
  res.write(": open\n\n");

  session.streams.add(res);
  req.on("close", () => session.streams.delete(res));
  log.debug(`MCP event stream opened for session ${sessionId}`);
}

/**
 * Check if a port is available by attempting to bind to it
 * @param {number} port - Port to check
 * @param {string} host - Host to bind to
 * @returns {Promise<boolean>} - True if port is available
 */
function isPortAvailable(port, host = DEFAULT_HOST) {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

/**
 * Find an available port by checking actual system availability
 * @param {number} startPort - Port to start checking from
 * @param {string} host - Host to bind to
 * @param {number} maxAttempts - Maximum ports to try
 * @returns {Promise<number>} - Available port number
 */
async function findAvailablePort(startPort, host = DEFAULT_HOST, maxAttempts = 100) {
  let port = startPort;

  for (let i = 0; i < maxAttempts; i++) {
    if (await isPortAvailable(port, host)) {
      return port;
    }
    log.debug(`Port ${port} in use, trying next`);
    port++;
  }

  throw new Error(
    `Could not find available port after ${maxAttempts} attempts starting from ${startPort}`,
  );
}

/**
 * Start the HTTP bridge server
 */
async function startBridge(config = {}) {
  const requestedPort = config.port ?? DEFAULT_PORT;
  const host = config.host ?? DEFAULT_HOST;

  // Minted per run, never persisted beyond the endpoint file, so a token that
  // leaks is worth nothing once the editor is closed.
  const token = crypto.randomUUID();

  // Find an available port
  const port = await findAvailablePort(requestedPort, host);
  if (port !== requestedPort) {
    log.debug(`Requested port ${requestedPort} unavailable, using ${port}`);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    const pathname = url.pathname;

    try {
      if (refuseBrowsers(req, res)) return;

      // GET /health - Health check. The one route a caller may reach before it
      // holds the token: it is how a client confirms a published endpoint is
      // still the bridge that published it.
      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, { status: "ok", timestamp: Date.now() });
        return;
      }

      if (refuseUntrusted(req, res, token)) return;

      // A client states the version it settled on at initialize. Absent, the
      // transport says to read it as 2025-03-26 rather than to refuse.
      const declaredVersion = req.headers["mcp-protocol-version"] ?? ASSUMED_PROTOCOL_VERSION;
      if (!SUPPORTED_PROTOCOL_VERSIONS.includes(declaredVersion)) {
        sendJson(
          res,
          {
            error: `Unsupported MCP-Protocol-Version: ${declaredVersion}`,
            supported: SUPPORTED_PROTOCOL_VERSIONS,
          },
          400,
        );
        return;
      }

      // POST /mcp - MCP Protocol endpoint
      if (req.method === "POST" && pathname === "/mcp") {
        await handleMcpEndpoint(req, res);
        return;
      }

      // GET /mcp - the server's own channel to the client
      if (req.method === "GET" && pathname === "/mcp") {
        handleEventStream(req, res, req.headers["mcp-session-id"]);
        return;
      }

      // DELETE /mcp - Session termination
      if (req.method === "DELETE" && pathname === "/mcp") {
        const sessionId = req.headers["mcp-session-id"];
        if (sessionId && sessions.has(sessionId)) {
          sessions.delete(sessionId);
          log.debug(`MCP session terminated: ${sessionId}`);
        }
        res.writeHead(204);
        res.end();
        return;
      }

      // GET /tools - List available tools (REST API)
      if (req.method === "GET" && pathname === "/tools") {
        sendJson(res, { tools: listEnabledTools() });
        return;
      }

      // POST /tools/:toolName - Execute a tool (REST API)
      //
      // Any name, not just the PascalCase the built-ins happen to use: an
      // external package chooses its own, and the route used to list tools it
      // then refused to dispatch.
      const toolMatch = pathname.match(/^\/tools\/([^/]+)$/);
      if (req.method === "POST" && toolMatch) {
        const toolName = decodeURIComponent(toolMatch[1]);
        const args = await parseBody(req);
        log.debug(`HTTP POST /tools/${toolName}`, { args });

        const result = await executeTool(toolName, args);

        if (result.success) {
          sendJson(res, result);
        } else {
          log.debug(`Tool request failed: ${toolName}`, {
            error: result.error,
          });
          sendJson(res, result, 400);
        }
        return;
      }

      // 404 Not Found
      log.debug(`404 Not Found: ${req.method} ${pathname}`);
      sendJson(res, { error: "Not found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`HTTP error: ${message}`);
      sendJson(res, { error: message }, 500);
    }
  });

  // Wait for the socket to bind so the reported port is the real one
  // (port 0 asks the OS for any free ephemeral port).
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", resolve);
    server.listen(port, host);
  });
  const boundPort = server.address().port;

  // Published only once the socket is bound, so anything that finds the file
  // finds a bridge already answering.
  const endpointFile = endpoint.publish({ port: boundPort, host, token });

  // Turning a tool off is a change to the list a client is holding, exactly
  // as a package registering one is.
  const configWatch = new CompositeDisposable(
    lumine.config.onDidChange("lumine-mcp.toolList", notifyToolsListChanged),
    lumine.config.onDidChange("lumine-mcp.listMode", notifyToolsListChanged),
  );

  const builtinTools = getToolsList();
  log.debug(`Bridge listening on http://${host}:${boundPort}`);
  log.debug(`Endpoint published at ${endpointFile}`);
  log.debug(`Available tools: ${builtinTools.map((t) => t.name).join(", ")}`);

  return {
    port: boundPort,
    host,
    token,
    endpointFile,
    stop: () =>
      new Promise((resolve, reject) => {
        // Withdrawn first: a client that reads the file after this point is
        // better off finding nothing than finding a socket mid-close.
        endpoint.unpublish(boundPort);
        configWatch.dispose();
        // An SSE stream is a connection with no end of its own, and
        // server.close() waits for every connection to finish. Ending them is
        // what lets the socket shut rather than hang on its own clients.
        for (const session of sessions.values()) {
          for (const stream of session.streams) stream.end();
        }
        sessions.clear();
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

/**
 * Stop the bridge server
 */
async function stopBridge(bridge) {
  await bridge.stop();
  log.debug("Bridge stopped");
}

module.exports = { startBridge, stopBridge, setExternalTools, openStreamCount };
