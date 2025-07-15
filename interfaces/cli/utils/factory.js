const BaseCommand = require("../lib/base.js");
const { createCommandDefinitions } = require("../../../agent/interface.js");

/**
 * Creates an oclif command class from a unified command definition
 */
function createOclifCommand(commandName) {
  // Get the command definition once during class creation
  const tempAgent = { workingDir: process.cwd() };
  const definitions = createCommandDefinitions(tempAgent);
  const commandDef = definitions[commandName];

  const DynamicCommand = class extends BaseCommand {
    async run() {
      try {
        const { args, flags } = await this.parse(this.constructor);

        // Special handling for edit mode
        if (commandName === "edit") {
          await this.setupAgent(args.file, flags);

          // Build environment for edit mode
          await this.agent.buildEnv(flags);

          // Start interactive mode
          const ReadlineInterface = require("../../readline.js");
          const readlineInterface = new ReadlineInterface(this.agent);
          this.agent.readlineInterface = readlineInterface;
          await readlineInterface.start();
        } else {
          // For run and sandbox commands, use the unified command system
          const fileArg = args.file || args.action || null;
          await this.setupAgent(fileArg, flags);

          if (commandName === "run") {
            // Set error limit higher for run command
            this.agent.errorLimit = 100;
          }

          // Execute through unified command system
          await this.agent.executeUnifiedCommand(commandName, [fileArg], flags);
        }
      } catch (error) {
        console.error(`Error executing ${commandName} command:`, error);
        process.exit(1);
      }
    }
  };

  // Set static properties directly on the class
  DynamicCommand.description = commandDef?.description || "";
  DynamicCommand.args = commandDef?.args || {};
  DynamicCommand.flags = commandDef?.flags || {};

  return DynamicCommand;
}

module.exports = { createOclifCommand };
