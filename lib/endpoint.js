/**
 * Remove endpoint records written by lumine-mcp releases that used a file
 * registry for discovery. New bridges never write here: a client is given a
 * port explicitly and asks the matching editor window for authorization.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

function legacyRegistryDir() {
  const home = process.env.LUMINE_HOME || path.join(os.homedir(), ".lumine");
  return path.join(home, "mcp");
}

/**
 * Delete only files that have both the old numeric filename and the old record
 * shape. A numeric JSON file belonging to somebody else remains untouched.
 * The port in the body must agree with the filename, which also avoids treating
 * a copied or renamed JSON document as one of our records.
 */
function cleanupLegacyRegistry(dir = legacyRegistryDir()) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const name of names) {
    const match = /^(\d+)\.json$/.exec(name);
    if (!match) continue;

    try {
      const file = path.join(dir, name);
      const entry = JSON.parse(fs.readFileSync(file, "utf8"));
      const keys = entry && typeof entry === "object" ? Object.keys(entry).sort() : [];
      const hasLegacyShape =
        keys.join(",") === "host,pid,port,token,updatedAt" &&
        entry.port === Number(match[1]) &&
        typeof entry.host === "string" &&
        typeof entry.token === "string" &&
        typeof entry.pid === "number" &&
        typeof entry.updatedAt === "number";
      if (!hasLegacyShape) continue;
      fs.rmSync(file);
      removed++;
    } catch {
      /* unreadable, half-written, or not ours */
    }
  }

  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    /* another window or process changed the directory */
  }

  return removed;
}

module.exports = { legacyRegistryDir, cleanupLegacyRegistry };
