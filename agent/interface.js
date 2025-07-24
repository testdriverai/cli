const path = require("path");
const { Args, Flags } = require("@oclif/core");

/**
 * Creates command definitions using oclif format as the single source of truth
 * @param {Object} agent - The TestDriverAgent instance
 * @returns {Object} Command definitions object in oclif format
 */
function createCommandDefinitions(agent) {
  const normalizeFilePath = (file) => {
    if (!file) {
      file = "testdriver/testdriver.yaml";
    }

    file = path.join(agent.workingDir, file);
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) {
      file += ".yaml";
    }

    return file;
  };

  return {
    run: {
      description: "Run a test file",
      args: {
        file: Args.string({
          description: "Test file to run",
          default: "testdriver/testdriver.yaml",
          required: false,
        }),
      },
      flags: {
        heal: Flags.boolean({
          description: "Enable automatic error recovery mode",
          default: false,
        }),
        write: Flags.boolean({
          description: "Save AI modifications to the test file",
          default: false,
        }),
        headless: Flags.boolean({
          description: "Run in headless mode (no GUI)",
          default: false,
        }),
        new: Flags.boolean({
          description:
            "Create a new sandbox instead of reconnecting to an existing one",
          default: false,
        }),
        "sandbox-ami": Flags.string({
          description: "Specify AMI ID for sandbox instance (e.g., ami-1234)",
        }),
        "sandbox-instance": Flags.string({
          description: "Specify EC2 instance type for sandbox (e.g., i3.metal)",
        }),
        summary: Flags.string({
          description: "Specify output file for summarize results",
        }),
      },
      handler: async (args, flags) => {
        // Use --path flag if provided, otherwise fall back to args.file
        const file = normalizeFilePath(args.file);

        await agent.runLifecycle("prerun");
        // When run() is called through run.js CLI command, shouldExit should be true
        const shouldExit = agent.cliArgs?.command === "run";
        await agent.run(file, flags.write, shouldExit);
      },
    },

    edit: {
      description: "Edit a test file interactively",
      args: {
        file: Args.string({
          description: "Test file to edit",
          default: "testdriver/testdriver.yaml",
          required: false,
        }),
      },
      flags: {
        heal: Flags.boolean({
          description: "Enable automatic error recovery mode",
          default: false,
        }),
        headless: Flags.boolean({
          description: "Run in headless mode",
          default: false,
        }),
        new: Flags.boolean({
          description:
            "Create a new sandbox instead of reconnecting to an existing one",
          default: false,
        }),
        "sandbox-ami": Flags.string({
          description: "Specify AMI ID for sandbox instance (e.g., ami-1234)",
        }),
        "sandbox-instance": Flags.string({
          description: "Specify EC2 instance type for sandbox (e.g., i3.metal)",
        }),
        summary: Flags.string({
          description: "Specify output file for summarize results",
        }),
      },
      handler: async () => {
        // Edit mode is handled by the CLI interface via factory.js
        // This handler should not be called directly
        throw new Error("Edit mode should be handled by CLI interface");
      },
    },

    // Interactive commands that can be used within edit mode
    explore: {
      description: "Explore and interact with the current environment",
      args: {
        prompt: Args.string({
          description: "What you want to explore or do",
          required: false,
        }),
      },
      flags: {},
      handler: async (args) => {
        await agent.exploratoryLoop(args.prompt || "", false, true, true);
      },
    },

    save: {
      description: "Save the current test script",
      args: {
        filename: Args.string({
          description: "Optional filename to save to",
          required: false,
        }),
      },
      flags: {},
      handler: async (args) => {
        await agent.save(args.filename);
      },
    },

    exit: {
      description: "Exit the TestDriver agent",
      args: {},
      flags: {},
      handler: async () => {
        await agent.exit(false);
      },
    },

    help: {
      description: "Show help information",
      args: {},
      flags: {},
      handler: async () => {
        agent.showHelp();
      },
    },

    version: {
      description: "Show version information",
      args: {},
      flags: {},
      handler: async () => {
        const packageJson = require("../package.json");
        console.log(`TestDriver.ai v${packageJson.version}`);
      },
    },
  };
}

module.exports = { createCommandDefinitions };
