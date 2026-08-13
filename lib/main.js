const { CompositeDisposable, Disposable } = require("lumine");
const { startBridge, stopBridge, setExternalTools } = require("./bridge");
const { getToolsList, getToolByName } = require("./tools");
const ToggleToolsView = require("./toggle");
const { createLogger } = require("./log");

const log = createLogger("Main");

// External MCP tools registered by other packages
const externalTools = new Map();

module.exports = {
  subscriptions: null,
  bridge: null,
  bridgePort: null,
  toggleToolsView: null,

  activate() {
    log.debug("Activating lumine-mcp package");
    this.subscriptions = new CompositeDisposable();

    // Create toggle tools view
    this.toggleToolsView = new ToggleToolsView(() => {
      const builtin = getToolsList().map((t) => ({ ...t, source: "built-in" }));
      const external = Array.from(externalTools.values()).map((t) => ({
        name: t.name,
        description: t.description || "",
        source: "external",
      }));
      return [...builtin, ...external];
    });

    // Register commands
    this.subscriptions.add(
      lumine.commands.add("lumine-workspace", {
        "lumine-mcp:toggle-tools": () => this.toggleToolsView.toggle(),
        "lumine-mcp:start": () => this.start(),
        "lumine-mcp:stop": () => this.stop(),
        "lumine-mcp:status": () => this.showStatus(),
      }),
    );

    // Auto-start if enabled
    if (lumine.config.get("lumine-mcp.autoStart")) {
      this.startBridge();
    }
  },

  // Returned rather than left running: the editor awaits a deactivate that
  // gives it a promise, and without that a window reload can reach the next
  // activation while the old socket still holds the port — which is answered
  // by taking the next one, stranding whatever was configured for the first.
  deactivate() {
    log.debug("Deactivating lumine-mcp package");
    this.subscriptions?.dispose();
    this.toggleToolsView?.destroy();
    return this.stopBridge();
  },

  serialize() {
    return {};
  },

  // Command handlers
  async start() {
    if (this.bridge) {
      lumine.notifications.addHint("MCP bridge is already running", {
        detail: `Port: ${this.bridgePort}`,
      });
      return;
    }
    await this.startBridge();
    if (this.bridge) {
      lumine.notifications.addHint("MCP bridge started", {
        detail: `Port: ${this.bridgePort}`,
      });
    }
  },

  async stop() {
    if (!this.bridge) {
      lumine.notifications.addHint("MCP bridge is not running");
      return;
    }
    await this.stopBridge();
    lumine.notifications.addHint("MCP bridge stopped");
  },

  showStatus() {
    if (this.bridge) {
      // The token is deliberately not shown: a client reads it out of the
      // endpoint file itself, and a notification is a poor place to leave one.
      lumine.notifications.addHint("MCP bridge is running", {
        detail:
          `Port: ${this.bridgePort}\nHost: 127.0.0.1\n` +
          `Endpoint: ${this.bridge.endpointFile}\n\n` +
          "Clients find this bridge on their own; no port needs configuring.",
        dismissable: true,
      });
    } else {
      lumine.notifications.addHint("MCP bridge is not running", {
        detail: "Use 'Lumine MCP: Start' command to start the bridge",
        dismissable: true,
      });
    }
  },

  // Bridge management
  async startBridge() {
    if (this.bridge) {
      log.debug("Bridge already running");
      return;
    }

    try {
      const basePort = lumine.config.get("lumine-mcp.bridgePort") || 3000;
      log.debug("Starting MCP bridge", { basePort });

      this.bridge = await startBridge({ port: basePort });
      this.bridgePort = this.bridge.port;

      log.debug(`MCP bridge started on port ${this.bridgePort}`);
    } catch (error) {
      log.error("Failed to start MCP bridge", error);
      lumine.notifications.addError("Failed to start MCP bridge", {
        detail: error.message,
        dismissable: true,
      });
    }
  },

  async stopBridge() {
    if (this.bridge) {
      log.debug("Stopping MCP bridge");
      try {
        await stopBridge(this.bridge);
        log.debug("MCP bridge stopped");
      } catch (err) {
        log.error("Error stopping bridge", err);
      }
      this.bridge = null;
      this.bridgePort = null;
    }
  },

  /**
   * Service API for other packages.
   * Provides access to the MCP bridge
   */
  provideMcpBridge() {
    return {
      /**
       * Get the current MCP bridge port
       * @returns {number|null} The port number or null if bridge not running
       */
      getBridgePort: () => this.bridgePort,

      /**
       * Check if the bridge is running
       * @returns {boolean}
       */
      isRunning: () => this.bridge !== null,

      /**
       * Get the path to the MCP server script
       * @returns {string} Absolute path to server.js
       */
      getServerPath: () => require.resolve("./server"),
    };
  },

  /**
   * Consume mcp.tools service from external packages
   * External packages provide tools via providedServices in package.json
   *
   * @param {Array} tools - Array of tool definitions
   * @returns {Disposable} - Disposable to unregister tools when package deactivates
   */
  consumeMcpTools(tools) {
    if (!Array.isArray(tools)) {
      log.error("Invalid MCP tools provider: must return an array of tools");
      return new Disposable();
    }

    const registered = [];
    for (const tool of tools) {
      if (!tool.name || !tool.execute) {
        log.error("Invalid tool definition: must have name and execute", {
          tool,
        });
        continue;
      }
      // A built-in of the same name wins at execution, so registering one
      // here would put a tool in the list that nothing could ever call.
      if (getToolByName(tool.name)) {
        log.error(`Rejected external MCP tool ${tool.name}: a builtin already has that name`);
        continue;
      }
      externalTools.set(tool.name, tool);
      registered.push(tool);
      log.debug(`Registered external MCP tool: ${tool.name}`);
    }

    // Update bridge with new tools
    setExternalTools(externalTools);

    log.debug(`Registered ${registered.length} external MCP tools`);

    // Return disposable for cleanup
    return new Disposable(() => {
      for (const tool of registered) {
        // Only if it is still ours. Two packages may claim one name, and the
        // loser leaving used to take the winner's tool with it.
        if (externalTools.get(tool.name) === tool) externalTools.delete(tool.name);
      }
      setExternalTools(externalTools);
      log.debug(`Unregistered external MCP tools: ${registered.map((t) => t.name).join(", ")}`);
    });
  },
};
