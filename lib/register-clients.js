"use strict";

const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SERVER_NAME = "lumine";
const NODE_COMMAND = "node";
const PORT_ENVIRONMENT_VARIABLE = "LUMINE_BRIDGE_PORT";
const CODEX_TOOL_TIMEOUT = 75;
const PROCESS_TIMEOUT = 20_000;
const MAX_OUTPUT = 64 * 1024;

class RegistrationError extends Error {}

function trimOutput(value) {
  const text = String(value || "").trim();
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}

function runProcess(command, args, { cwd, env = process.env, timeout = PROCESS_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = childProcess.spawn(command, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let finished = false;
    const append = (current, chunk) =>
      current.length >= MAX_OUTPUT ? current : (current + chunk).slice(0, MAX_OUTPUT);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => (stdout = append(stdout, chunk)));
    child.stderr?.on("data", (chunk) => (stderr = append(stderr, chunk)));

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill();
      reject(new RegistrationError(`${command} timed out`));
    }, timeout);

    child.once("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code, signal, stderr, stdout });
    });
  });
}

function successful(result, operation) {
  if (result.code === 0) return result;
  const detail = trimOutput(result.stderr || result.stdout);
  throw new RegistrationError(`${operation} failed${detail ? `: ${detail}` : ""}`);
}

function commandExistsError(error) {
  return error?.code === "ENOENT" || error?.code === "EINVAL";
}

function pathEqual(left, right, platform = process.platform) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const normalize = (value) => path.normalize(value.replace(/^['"]|['"]$/g, ""));
  const a = normalize(left);
  const b = normalize(right);
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function parseClaudeEntry(output) {
  const field = (name) =>
    output.match(new RegExp(`^\\s*${name}:\\s*(.*?)\\s*$`, "im"))?.[1]?.trim() || null;
  return {
    args: field("Args"),
    command: field("Command"),
    scope: field("Scope"),
    type: field("Type"),
  };
}

function claudeEntryMatches(entry, serverPath, platform = process.platform) {
  return (
    /user/i.test(entry.scope || "") &&
    entry.type === "stdio" &&
    entry.command === NODE_COMMAND &&
    pathEqual(entry.args, serverPath, platform)
  );
}

function codexEntryMatches(entry, serverPath, platform = process.platform) {
  const transport = entry?.transport;
  return (
    transport?.type === "stdio" &&
    transport.command === NODE_COMMAND &&
    Array.isArray(transport.args) &&
    transport.args.length === 1 &&
    pathEqual(transport.args[0], serverPath, platform)
  );
}

function codexEntryComplete(entry) {
  const variables = entry?.transport?.env_vars;
  return (
    Array.isArray(variables) &&
    variables.includes(PORT_ENVIRONMENT_VARIABLE) &&
    Number(entry.tool_timeout_sec) >= CODEX_TOOL_TIMEOUT
  );
}

function missingServer(result) {
  return /No MCP server named|not found|does not exist/i.test(`${result.stderr}\n${result.stdout}`);
}

function newlineFor(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function patchCodexToml(text, envVars = []) {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const newline = newlineFor(text);
  const trailingNewline = /\r?\n$/.test(text);
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const header = lines.findIndex((line) => line.trim() === `[mcp_servers.${SERVER_NAME}]`);
  if (header === -1) throw new RegistrationError("Codex did not create its Lumine MCP table");

  let end = header + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const body = lines
    .slice(header + 1, end)
    .filter((line) => !/^\s*(?:env_vars|tool_timeout_sec)\s*=/.test(line));
  while (body.length && body[body.length - 1].trim() === "") body.pop();

  const variables = [...new Set([...envVars, PORT_ENVIRONMENT_VARIABLE])];
  const encodedVariables = variables.map((value) => JSON.stringify(value)).join(", ");
  body.push(`env_vars = [${encodedVariables}]`, `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT}`);
  lines.splice(header + 1, end - header - 1, ...body);
  const result = `${bom}${lines.join(newline)}`;
  return trailingNewline ? `${result.replace(/(?:\r?\n)*$/, "")}${newline}` : result;
}

function writeAtomic(filePath, contents, fileSystem = fs) {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  fileSystem.writeFileSync(temporary, contents, { mode: 0o600 });
  try {
    fileSystem.renameSync(temporary, filePath);
  } catch (error) {
    try {
      fileSystem.rmSync(temporary, { force: true });
    } catch {
      /* Preserve the original write error. */
    }
    throw error;
  }
}

function restoreSnapshot(filePath, snapshot, fileSystem = fs) {
  if (snapshot == null) {
    fileSystem.rmSync(filePath, { force: true });
  } else {
    writeAtomic(filePath, snapshot, fileSystem);
  }
}

class ClientRegistrar {
  constructor({
    activeDirectory = () => process.cwd(),
    confirm,
    environment = process.env,
    fileSystem = fs,
    homeDirectory = os.homedir(),
    notify,
    platform = process.platform,
    run = runProcess,
    serverPath,
    temporaryDirectory = os.tmpdir(),
  }) {
    this.activeDirectory = activeDirectory;
    this.confirm = confirm;
    this.environment = environment;
    this.fileSystem = fileSystem;
    this.homeDirectory = homeDirectory;
    this.notify = notify;
    this.platform = platform;
    this.run = run;
    this.serverPath = serverPath;
    this.temporaryDirectory = temporaryDirectory;
    this.inFlight = new Map();
  }

  register(client) {
    if (this.inFlight.has(client)) return this.inFlight.get(client);
    const operation = this.perform(client)
      .catch((error) => {
        const executable = client === "claude" ? "Claude Code" : "Codex";
        const detail = commandExistsError(error)
          ? `${executable} or node is not available on PATH.`
          : error.message || String(error);
        this.notify.error(`Could not register Lumine with ${executable}`, detail);
        return false;
      })
      .finally(() => {
        if (this.inFlight.get(client) === operation) this.inFlight.delete(client);
      });
    this.inFlight.set(client, operation);
    return operation;
  }

  async perform(client) {
    successful(await this.run(NODE_COMMAND, ["--version"]), "Checking node");
    if (client === "claude") return this.registerClaude();
    if (client === "codex") return this.registerCodex();
    throw new RegistrationError(`Unknown MCP client: ${client}`);
  }

  async shouldReplace(clientName, summary) {
    const answer = await this.confirm({
      message: `${clientName} already has an MCP server named '${SERVER_NAME}'`,
      detail: `${summary}\n\nReplace only that server entry with the Lumine configuration?`,
      buttons: ["Replace", "Cancel"],
    });
    return answer === 0;
  }

  async neutralDirectory() {
    return this.fileSystem.mkdtempSync(path.join(this.temporaryDirectory, "lumine-mcp-register-"));
  }

  async registerClaude() {
    const claude = "claude";
    const neutral = await this.neutralDirectory();
    const configPath = this.claudeConfigPath();
    const original = this.fileSystem.existsSync(configPath)
      ? this.fileSystem.readFileSync(configPath, "utf8")
      : null;
    const ownedStates = new Set();
    let existing = null;
    try {
      const found = await this.run(claude, ["mcp", "get", SERVER_NAME], { cwd: neutral });
      if (found.code === 0) existing = parseClaudeEntry(found.stdout);
      else if (!missingServer(found)) successful(found, "Reading Claude Code MCP configuration");

      if (existing && claudeEntryMatches(existing, this.serverPath, this.platform)) {
        this.notify.success(
          "Lumine is already registered with Claude Code",
          "No changes were needed.",
        );
        return true;
      }
      if (
        existing &&
        !(await this.shouldReplace(
          "Claude Code",
          `Type: ${existing.type || "unknown"}\nCommand: ${existing.command || "unknown"}\nArgs: ${existing.args || ""}`,
        ))
      ) {
        return false;
      }

      if (existing) {
        successful(
          await this.run(claude, ["mcp", "remove", "--scope", "user", SERVER_NAME], {
            cwd: neutral,
          }),
          "Removing the previous Claude Code MCP entry",
        );
        ownedStates.add(
          this.fileSystem.existsSync(configPath)
            ? this.fileSystem.readFileSync(configPath, "utf8")
            : null,
        );
      }
      successful(
        await this.run(
          claude,
          [
            "mcp",
            "add",
            "--scope",
            "user",
            "--transport",
            "stdio",
            SERVER_NAME,
            "--",
            NODE_COMMAND,
            this.serverPath,
          ],
          { cwd: neutral },
        ),
        "Registering Claude Code MCP server",
      );
      if (this.fileSystem.existsSync(configPath)) {
        ownedStates.add(this.fileSystem.readFileSync(configPath, "utf8"));
      }

      const verified = successful(
        await this.run(claude, ["mcp", "get", SERVER_NAME], { cwd: neutral }),
        "Verifying Claude Code MCP registration",
      );
      if (!claudeEntryMatches(parseClaudeEntry(verified.stdout), this.serverPath, this.platform)) {
        throw new RegistrationError("Claude Code did not retain the expected Lumine MCP command");
      }

      const active = await this.run(claude, ["mcp", "get", SERVER_NAME], {
        cwd: this.activeDirectory(),
      });
      const activeEntry = active.code === 0 ? parseClaudeEntry(active.stdout) : null;
      if (activeEntry && !/user/i.test(activeEntry.scope || "")) {
        this.notify.warning(
          "Claude Code registered Lumine globally",
          `A ${activeEntry.scope} entry named '${SERVER_NAME}' shadows it in the current project.`,
        );
      } else {
        this.notify.success(
          "Lumine registered with Claude Code",
          "Start a new Claude Code session to load the MCP server.",
        );
      }
      return true;
    } catch (error) {
      try {
        const current = this.fileSystem.existsSync(configPath)
          ? this.fileSystem.readFileSync(configPath, "utf8")
          : null;
        if (ownedStates.has(current)) {
          restoreSnapshot(configPath, original, this.fileSystem);
        }
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Claude Code registration failed and its configuration could not be restored",
          { cause: rollbackError },
        );
      }
      throw error;
    } finally {
      this.fileSystem.rmSync(neutral, { recursive: true, force: true });
    }
  }

  claudeConfigPath() {
    if (this.environment.CLAUDE_CONFIG_DIR) {
      return path.join(this.environment.CLAUDE_CONFIG_DIR, ".claude.json");
    }
    return path.join(this.homeDirectory, ".claude.json");
  }

  codexConfigPath() {
    const root = this.environment.CODEX_HOME || path.join(this.homeDirectory, ".codex");
    return path.join(root, "config.toml");
  }

  async readCodexEntry(codex, cwd) {
    const result = await this.run(codex, ["mcp", "get", SERVER_NAME, "--json"], { cwd });
    if (result.code !== 0) {
      if (missingServer(result)) return null;
      successful(result, "Reading Codex MCP configuration");
    }
    try {
      return JSON.parse(result.stdout);
    } catch (error) {
      throw new RegistrationError("Codex returned invalid MCP configuration JSON", {
        cause: error,
      });
    }
  }

  async registerCodex() {
    const codex = "codex";
    const neutral = await this.neutralDirectory();
    const configPath = this.codexConfigPath();
    const original = this.fileSystem.existsSync(configPath)
      ? this.fileSystem.readFileSync(configPath, "utf8")
      : null;
    let rollbackSnapshot = original;
    const ownedStates = new Set();

    try {
      let existing = await this.readCodexEntry(codex, neutral);
      const canonical = existing && codexEntryMatches(existing, this.serverPath, this.platform);
      if (canonical && codexEntryComplete(existing)) {
        this.notify.success("Lumine is already registered with Codex", "No changes were needed.");
        return true;
      }
      if (
        existing &&
        !canonical &&
        !(await this.shouldReplace(
          "Codex",
          `Type: ${existing.transport?.type || "unknown"}\nCommand: ${existing.transport?.command || "unknown"}\nArgs: ${(existing.transport?.args || []).join(" ")}`,
        ))
      ) {
        return false;
      }

      if (!canonical) {
        successful(
          await this.run(codex, ["mcp", "add", SERVER_NAME, "--", NODE_COMMAND, this.serverPath], {
            cwd: neutral,
          }),
          "Registering Codex MCP server",
        );
        ownedStates.add(this.fileSystem.readFileSync(configPath, "utf8"));
        existing = await this.readCodexEntry(codex, neutral);
      }

      const current = this.fileSystem.readFileSync(configPath, "utf8");
      if (canonical) rollbackSnapshot = current;
      const variables = existing?.transport?.env_vars || [];
      const patched = patchCodexToml(current, variables);
      if (this.fileSystem.readFileSync(configPath, "utf8") !== current) {
        throw new RegistrationError("Codex configuration changed while Lumine was updating it");
      }
      writeAtomic(configPath, patched, this.fileSystem);
      ownedStates.add(patched);

      const verified = await this.readCodexEntry(codex, neutral);
      if (
        !codexEntryMatches(verified, this.serverPath, this.platform) ||
        !codexEntryComplete(verified)
      ) {
        throw new RegistrationError("Codex did not retain the complete Lumine MCP configuration");
      }
      this.notify.success(
        "Lumine registered with Codex",
        "Start a new Codex task or restart the client to load the MCP server.",
      );
      return true;
    } catch (error) {
      try {
        const current = this.fileSystem.existsSync(configPath)
          ? this.fileSystem.readFileSync(configPath, "utf8")
          : null;
        if (current != null && ownedStates.has(current))
          restoreSnapshot(configPath, rollbackSnapshot, this.fileSystem);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Codex registration failed and its configuration could not be restored",
          { cause: rollbackError },
        );
      }
      throw error;
    } finally {
      this.fileSystem.rmSync(neutral, { recursive: true, force: true });
    }
  }
}

module.exports = {
  CODEX_TOOL_TIMEOUT,
  ClientRegistrar,
  NODE_COMMAND,
  PORT_ENVIRONMENT_VARIABLE,
  RegistrationError,
  claudeEntryMatches,
  codexEntryComplete,
  codexEntryMatches,
  parseClaudeEntry,
  patchCodexToml,
  runProcess,
  writeAtomic,
};
