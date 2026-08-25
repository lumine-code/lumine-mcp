const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  ClientRegistrar,
  claudeEntryMatches,
  codexEntryComplete,
  codexEntryMatches,
  parseClaudeEntry,
  patchCodexToml,
} = require("../lib/register-clients");

describe("lumine-mcp client registration", () => {
  const serverPath = path.resolve("C:/Lumine packages/lumine-mcp/lib/server.js");
  let root, codexHome, claudeHome, notifications, confirmations, calls, state, registrar;

  const claudeOutput = (entry, scope = "User config (available in all your projects)") => `lumine:
  Scope: ${scope}
  Status: ✓ Connected
  Type: ${entry.type}
  Command: ${entry.command}
  Args: ${entry.args.join(" ")}
  Environment:
`;

  const codexEntryFromDisk = () => {
    if (!state.codexEntry) return null;
    const configPath = path.join(codexHome, "config.toml");
    const config = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
    const variables = config.match(/env_vars\s*=\s*\[([^\]]*)\]/)?.[1] || "";
    const envVars = [...variables.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    const timeout = Number(config.match(/tool_timeout_sec\s*=\s*(\d+)/)?.[1]) || null;
    return {
      name: "lumine",
      tool_timeout_sec: timeout,
      transport: { ...state.codexEntry.transport, env_vars: envVars },
    };
  };

  const fakeRun = async (command, args, options = {}) => {
    calls.push({ args, command, cwd: options.cwd });
    if (command === "node") return { code: 0, stderr: "", stdout: "v24.0.0\n" };

    if (command === "claude") {
      const action = args[1];
      if (action === "get") {
        if (!state.claudeEntry) {
          return { code: 1, stderr: "No MCP server named lumine", stdout: "" };
        }
        const scope = options.cwd === state.activeDirectory ? state.activeClaudeScope : undefined;
        return { code: 0, stderr: "", stdout: claudeOutput(state.claudeEntry, scope) };
      }
      if (action === "remove") {
        state.claudeEntry = null;
        fs.writeFileSync(path.join(claudeHome, ".claude.json"), JSON.stringify({ mcpServers: {} }));
        return { code: 0, stderr: "", stdout: "Removed\n" };
      }
      if (action === "add") {
        state.claudeEntry = {
          type: "stdio",
          command: args.at(-2),
          args: [args.at(-1)],
        };
        fs.writeFileSync(
          path.join(claudeHome, ".claude.json"),
          JSON.stringify({ mcpServers: { lumine: state.claudeEntry } }),
        );
        return { code: 0, stderr: "", stdout: "Added\n" };
      }
    }

    if (command === "codex") {
      const action = args[1];
      if (action === "get") {
        const entry = codexEntryFromDisk();
        if (!entry) return { code: 1, stderr: "No MCP server named 'lumine' found", stdout: "" };
        const reported = state.codexVerifyFails
          ? { ...entry, transport: { ...entry.transport, command: "wrong" } }
          : entry;
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify(reported),
        };
      }
      if (action === "add") {
        state.codexEntry = {
          transport: { type: "stdio", command: args.at(-2), args: [args.at(-1)] },
        };
        fs.mkdirSync(codexHome, { recursive: true });
        fs.writeFileSync(
          path.join(codexHome, "config.toml"),
          `${state.codexPrefix}[mcp_servers.lumine]\ncommand = "${args.at(-2)}"\nargs = [${JSON.stringify(args.at(-1))}]\n`,
        );
        return { code: 0, stderr: "", stdout: "Added\n" };
      }
    }
    throw new Error(`Unexpected process: ${command} ${args.join(" ")}`);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-mcp-register-spec-"));
    codexHome = path.join(root, "codex");
    claudeHome = path.join(root, "claude");
    fs.mkdirSync(codexHome);
    fs.mkdirSync(claudeHome);
    notifications = {
      error: jasmine.createSpy("error"),
      success: jasmine.createSpy("success"),
      warning: jasmine.createSpy("warning"),
    };
    confirmations = jasmine.createSpy("confirm").and.resolveTo(0);
    calls = [];
    state = {
      activeClaudeScope: "User config (available in all your projects)",
      activeDirectory: path.join(root, "project"),
      claudeEntry: null,
      codexEntry: null,
      codexPrefix: 'theme = "dark"\n\n',
      codexVerifyFails: false,
    };
    registrar = new ClientRegistrar({
      activeDirectory: () => state.activeDirectory,
      confirm: confirmations,
      environment: { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome },
      homeDirectory: root,
      notify: notifications,
      run: fakeRun,
      serverPath,
      temporaryDirectory: root,
    });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("keeps the six package commands in one flat menu", () => {
    const menu = require("../menus/main.json").menu[0].submenu[0].submenu;
    expect(menu.length).toBe(6);
    expect(menu.some((item) => item.type === "separator" || item.submenu)).toBe(false);
    expect(menu.map((item) => item.command)).toContain("lumine-mcp:register-to-claude");
    expect(menu.map((item) => item.command)).toContain("lumine-mcp:register-to-codex");
  });

  it("parses and compares Claude Code's user entry", () => {
    const entry = parseClaudeEntry(
      claudeOutput({ type: "stdio", command: "node", args: [serverPath] }),
    );
    expect(claudeEntryMatches(entry, serverPath, "win32")).toBe(true);
  });

  it("registers Claude Code at user scope without persisting a port", async () => {
    expect(await registrar.register("claude")).toBe(true);
    const add = calls.find((call) => call.command === "claude" && call.args[1] === "add");
    expect(add.args).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "--transport",
      "stdio",
      "lumine",
      "--",
      "node",
      serverPath,
    ]);
    expect(JSON.stringify(add)).not.toContain("LUMINE_BRIDGE_PORT");
    expect(confirmations).not.toHaveBeenCalled();
    expect(notifications.success).toHaveBeenCalled();
  });

  it("does nothing when Claude Code already has the canonical entry", async () => {
    state.claudeEntry = { type: "stdio", command: "node", args: [serverPath] };
    expect(await registrar.register("claude")).toBe(true);
    expect(calls.some((call) => call.args[1] === "add")).toBe(false);
    expect(confirmations).not.toHaveBeenCalled();
  });

  it("honors Cancel before replacing a different Claude Code entry", async () => {
    state.claudeEntry = { type: "stdio", command: "other", args: ["server"] };
    confirmations.and.resolveTo(1);
    expect(await registrar.register("claude")).toBe(false);
    expect(calls.some((call) => call.args[1] === "remove")).toBe(false);
  });

  it("replaces a different Claude Code entry only after confirmation", async () => {
    state.claudeEntry = { type: "stdio", command: "other", args: ["server"] };
    fs.writeFileSync(
      path.join(claudeHome, ".claude.json"),
      JSON.stringify({ keep: true, mcpServers: { lumine: state.claudeEntry } }),
    );
    expect(await registrar.register("claude")).toBe(true);
    expect(confirmations).toHaveBeenCalled();
    expect(calls.some((call) => call.args[1] === "remove")).toBe(true);
    expect(state.claudeEntry.command).toBe("node");
  });

  it("warns when a project Claude entry shadows the user registration", async () => {
    state.activeClaudeScope = "Local config";
    expect(await registrar.register("claude")).toBe(true);
    expect(notifications.warning).toHaveBeenCalled();
  });

  it("preserves unrelated Codex TOML while adding the required fields", () => {
    const source = `theme = "dark"\r\n\r\n[mcp_servers.lumine]\r\ncommand = "node"\r\nargs = ["server.js"]\r\n\r\n[other]\r\nvalue = 1\r\n`;
    const patched = patchCodexToml(source, ["EXISTING"]);
    expect(patched).toContain('theme = "dark"\r\n');
    expect(patched).toContain('env_vars = ["EXISTING", "LUMINE_BRIDGE_PORT"]\r\n');
    expect(patched).toContain("tool_timeout_sec = 75\r\n");
    expect(patched).toContain("[other]\r\nvalue = 1\r\n");
  });

  it("registers Codex globally and patches only its generated entry", async () => {
    expect(await registrar.register("codex")).toBe(true);
    const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    expect(config).toContain('theme = "dark"');
    expect(config).toContain('command = "node"');
    expect(config).toContain('env_vars = ["LUMINE_BRIDGE_PORT"]');
    expect(config).toContain("tool_timeout_sec = 75");
    expect(config).not.toContain("TOKEN");
    expect(confirmations).not.toHaveBeenCalled();
  });

  it("repairs an incomplete canonical Codex entry without replacing it", async () => {
    state.codexEntry = { transport: { type: "stdio", command: "node", args: [serverPath] } };
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      `[mcp_servers.lumine]\ncommand = "node"\nargs = [${JSON.stringify(serverPath)}]\nenabled = false\n`,
    );
    expect(await registrar.register("codex")).toBe(true);
    expect(calls.some((call) => call.command === "codex" && call.args[1] === "add")).toBe(false);
    expect(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8")).toContain(
      "enabled = false",
    );
  });

  it("honors Cancel before replacing a different Codex entry", async () => {
    state.codexEntry = { transport: { type: "stdio", command: "other", args: ["server"] } };
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      '[mcp_servers.lumine]\ncommand = "other"\n',
    );
    confirmations.and.resolveTo(1);
    expect(await registrar.register("codex")).toBe(false);
    expect(calls.some((call) => call.command === "codex" && call.args[1] === "add")).toBe(false);
  });

  it("recognizes a complete Codex entry", () => {
    const entry = {
      tool_timeout_sec: 80,
      transport: {
        type: "stdio",
        command: "node",
        args: [serverPath],
        env_vars: ["LUMINE_BRIDGE_PORT", "OTHER"],
      },
    };
    expect(codexEntryMatches(entry, serverPath, "win32")).toBe(true);
    expect(codexEntryComplete(entry)).toBe(true);
  });

  it("restores Codex config when post-write verification fails", async () => {
    const original = 'theme = "dark"\n';
    fs.writeFileSync(path.join(codexHome, "config.toml"), original);
    state.codexVerifyFails = true;

    expect(await registrar.register("codex")).toBe(false);
    expect(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8")).toBe(original);
    expect(notifications.error).toHaveBeenCalled();
  });

  it("coalesces parallel registration commands for one client", () => {
    let resolve;
    const pending = new Promise((done) => (resolve = done));
    spyOn(registrar, "perform").and.returnValue(pending);
    const first = registrar.register("codex");
    const second = registrar.register("codex");
    expect(second).toBe(first);
    resolve(true);
  });

  it("reports a missing executable without modifying configuration", async () => {
    registrar.run = async () => {
      const error = new Error("spawn node ENOENT");
      error.code = "ENOENT";
      throw error;
    };
    expect(await registrar.register("codex")).toBe(false);
    expect(notifications.error).toHaveBeenCalled();
    expect(fs.existsSync(path.join(codexHome, "config.toml"))).toBe(false);
  });
});
