/**
 * Where a running bridge publishes how to reach it.
 *
 * A bridge picks its port at startup and its token at every startup, so
 * neither can be written into a client's configuration ahead of time. Instead
 * each bridge drops a small file here naming both, and a client reads the
 * directory to find the editor rather than being told where it is.
 *
 * A file outlives the bridge that wrote it if the editor is killed, so a
 * reader must treat every entry as a claim and confirm it against /health
 * before trusting the token in it.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Where the registry lives.
 *
 * Read afresh every time rather than resolved once at load: LUMINE_HOME is the
 * real one even under `lumine --test`, so the spec suite redirects the registry
 * with LUMINE_MCP_REGISTRY instead of leaving test bridges where a client would
 * find them. A child process inherits the variable and so agrees on the answer.
 */
function registryDir() {
  if (process.env.LUMINE_MCP_REGISTRY) return process.env.LUMINE_MCP_REGISTRY;
  const home = process.env.LUMINE_HOME || path.join(os.homedir(), ".lumine");
  return path.join(home, "mcp");
}

function endpointPath(port) {
  return path.join(registryDir(), `${port}.json`);
}

/**
 * Record a listening bridge. Keyed by port, so a restart on the same port
 * replaces its own stale entry rather than adding a second one.
 */
function publish({ port, host, token }) {
  const file = endpointPath(port);
  fs.mkdirSync(registryDir(), { recursive: true });
  const entry = { port, host, token, pid: process.pid, updatedAt: Date.now() };
  // 0600 keeps the token to this user on POSIX; on Windows the mode is
  // ignored and the directory's own ACL is what stands between users.
  fs.writeFileSync(file, JSON.stringify(entry, null, 2), { mode: 0o600 });
  return file;
}

function unpublish(port) {
  fs.rmSync(endpointPath(port), { force: true });
}

/**
 * Every endpoint on record, most recently published first. Entries that are
 * unreadable or not shaped like an endpoint are skipped: the directory is on
 * disk and anything may be sitting in it.
 */
function list() {
  const dir = registryDir();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const entries = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      if (typeof entry?.port === "number" && typeof entry?.token === "string") {
        entries.push(entry);
      }
    } catch {
      /* half-written, or not ours */
    }
  }

  return entries.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

module.exports = { registryDir, endpointPath, publish, unpublish, list };
