const { name: SERVER_NAME, version: SERVER_VERSION } = require("../package.json");

// Newest first. A client naming one of these is answered in its own version;
// one naming anything else is answered in the newest and decides for itself
// whether to carry on. A client that sends no MCP-Protocol-Version header at
// all is 2025-03-26 by the transport's own back-compatibility rule, which is
// why that version stays on the list.
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const ASSUMED_PROTOCOL_VERSION = "2025-03-26";

function negotiateProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION;
}

function initializeResult(params = {}) {
  return {
    protocolVersion: negotiateProtocolVersion(params.protocolVersion),
    capabilities: {
      tools: { listChanged: true },
    },
    serverInfo: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
  };
}

module.exports = {
  SUPPORTED_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION,
  ASSUMED_PROTOCOL_VERSION,
  negotiateProtocolVersion,
  initializeResult,
};
