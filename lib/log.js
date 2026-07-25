/**
 * Simple logging for lumine-mcp
 */

const PREFIX = "[lumine-mcp]";

function isDebugEnabled() {
  return atom.config.get("lumine-mcp.debugMode") === true;
}

function createLogger(category) {
  return {
    debug: (...args) => isDebugEnabled() && console.log(`${PREFIX} [${category}]`, ...args),
    info: (...args) => console.log(`${PREFIX} [${category}]`, ...args),
    warn: (...args) => console.warn(`${PREFIX} [${category}]`, ...args),
    error: (...args) => console.error(`${PREFIX} [${category}]`, ...args),
  };
}

module.exports = { createLogger };
