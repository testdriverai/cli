#!/usr/bin/env node

// disable depreciation warnings
process.removeAllListeners("warning");

// package.json is included to get the version number
const packageJson = require("../package.json");

// nodejs modules
const fs = require("fs");
const os = require("os");

// third party modules
const path = require("path");
const yaml = require("js-yaml");
const sanitizeFilename = require("sanitize-filename");
const { EventEmitter2 } = require("eventemitter2");

// global utilities
const generator = require("./lib/generator.js");
const theme = require("./lib/theme.js");
const SourceMapper = require("./lib/source-mapper.js");

// agent modules
const { createParser } = require("./lib/parser.js");
const { createSystem } = require("./lib/system.js");
const { createCommander } = require("./lib/commander.js");
const { createCommands } = require("./lib/commands.js");
const { createSandbox } = require("./lib/sandbox.js");
const { createCommandDefinitions } = require("./interface.js");
const { createSDK } = require("./lib/sdk.js");
const { createConfig } = require("./lib/config.js");
const { createAnalytics } = require("./lib/analytics.js");
const { createSession } = require("./lib/session.js");
const { createOutputs } = require("./lib/outputs.js");

const isValidVersion = require("./lib/valid-version.js");
const { events, createEmitter, setEmitter } = require("./events.js");
const { createDebuggerProcess } = require("./lib/debugger.js");
let debuggerProcess = null; // single debugger process for all instances. otherwise they'll fight over ports. this should be in `web` anyway
let debuggerStarted = false;

class TestDriverAgent extends EventEmitter2 {
  constructor(environment = {}, cliArgs = {}) {
    super({
      wildcard: true,
      delimiter: ":",
      newListener: false,
      removeListener: false,
      maxListeners: 20,
      verboseMemoryLeak: false,
      ignoreErrors: false,
    }); // Create the agent's own emitter for internal events
    this.emitter = createEmitter();

    // Create config instance for this agent using provided environment
    this.config = createConfig(environment);

    // Store CLI arguments passed to this agent
    this.cliArgs = cliArgs;

    // Derive properties from cliArgs
    const flags = cliArgs.options || {};
    const firstArg = cliArgs.args && cliArgs.args[0];
    this.thisFile = firstArg || this.config.TD_DEFAULT_TEST_FILE;
    this.resultFile = flags.resultFile || null;
    this.newSandbox = flags.newSandbox || false;
    this.healMode = flags.healMode || flags.heal || false;
    this.sandboxId = flags.sandboxId || null;
    this.workingDir = flags.workingDir || process.cwd();

    // Resolve thisFile to absolute path with proper extension
    if (this.thisFile) {
      if (this.thisFile === ".") {
        this.thisFile = path.join(this.workingDir, "testdriver.yaml");
      } else {
        this.thisFile = path.join(this.workingDir, this.thisFile);
        if (
          !this.thisFile.endsWith(".yaml") &&
          !this.thisFile.endsWith(".yml")
        ) {
          this.thisFile += ".yaml";
        }
      }
    }

    // Set this emitter as the global current emitter for other modules to use
    setEmitter(this.emitter);

    // Create parser instance with this agent's emitter
    this.parser = createParser(this.emitter);

    // Create session instance for this agent
    this.session = createSession();

    // Create outputs instance for this agent
    this.outputs = createOutputs();

    // Create SDK instance with this agent's emitter, config, and session
    this.sdk = createSDK(this.emitter, this.config, this.session);

    // Create analytics instance with this agent's emitter, config, and session
    this.analytics = createAnalytics(this.emitter, this.config, this.session);

    // Create sandbox instance with this agent's emitter
    this.sandbox = createSandbox(this.emitter);

    // Create system instance with sandbox, config, and emitter
    this.system = createSystem(this.sandbox, this.config, this.emitter);

    // Create commands instance with this agent's emitter and system
    const commandsResult = createCommands(
      this.emitter,
      this.system,
      this.sandbox,
      this.config,
      this.session,
      () => this.sourceMapper.currentFilePath || this.thisFile,
    );
    this.commands = commandsResult.commands;

    // Create commander instance with this agent's emitter and commands
    this.commander = createCommander(
      this.emitter,
      this.commands,
      this.analytics,
      this.config,
      this.outputs,
      this.session,
    );

    // these are "in-memory" globals
    // they represent the current state of the agent
    this.lastPrompt = ""; // the last prompt to be input
    this.executionHistory = []; // a history of commands run in the current session
    this.errorCounts = {}; // counts of different errors encountered in this session
    this.errorLimit = 3; // the max number of times an error can be encountered before exiting
    this.checkCount = 0; // the number of times the AI has checked the task
    this.checkLimit = 7; // the max number of times the AI can check the task before exiting
    this.lastScreenshot = null; // the last screenshot taken by the agent
    this.readlineInterface = null; // the readline interface for interactive mode
    this.tasks = []; // list of prompts that the user has given us

    this.lastCommand = new Date().getTime();
    this.csv = [["command,time"]];
    this.debuggerUrl = null; // the debugger server URL

    // Source mapping for YAML files
    this.sourceMapper = new SourceMapper();

    // temporary file for command history
    this.commandHistoryFile = path.join(os.homedir(), ".testdriver_history");

    this.emitter.emit(events.log.log, JSON.stringify(environment));
    this.emitter.emit(events.log.log, JSON.stringify(cliArgs));
  }
  // single function to handle all program exits
  // allows us to save the current state, run lifecycle hooks, and track analytics
  async exit(failed = true, shouldSave = false, shouldRunLifecycle = false) {
    this.emitter.emit(events.log.log, theme.dim("exiting..."), true);

    shouldRunLifecycle = shouldRunLifecycle || this.cliArgs?.command == "run";

    if (shouldSave) {
      await this.save();
    }

    this.analytics.track("exit", { failed });

    if (shouldRunLifecycle) {
      await this.runLifecycle("postrun");
    }

    // Emit exit event with exit code and close readline interface
    this.readlineInterface?.close();
    this.emitter.emit(events.exit, failed ? 1 : 0);

    // we purposly never resolve this promise so the process will hang
    return new Promise(() => {
      // The process exit should be handled by the base/entry point listening to the exit event
    });
  }

  // fatal errors always exit the program
  // this ensure we log the error, summarize it, and exit cleanly
  async dieOnFatal(error) {
    // Show error with source context if available
    const errorContext = this.sourceMapper.getErrorWithSourceContext(error);
    if (errorContext) {
      this.emitter.emit(events.error.fatal, errorContext);
    } else {
      this.emitter.emit(
        events.error.fatal,
        theme.red("Fatal Error") + `\n${error}`,
      );
    }

    await this.summarize(error.message);
    // Always run postrun lifecycle script, even for fatal errors
    return await this.exit(true, false, true);
  }

  // creates a new "thread" in which the AI is given an error
  // and responds. notice `actOnMarkdown` which will continue
  // the thread until there are no more codeblocks to execute
  async haveAIResolveError(
    error,
    markdown,
    depth = 0,
    undo = true,
    shouldSave,
  ) {
    // healMode must be required to attempt to recover from errors
    // otherwise we go directly to fatal
    if (!this.healMode) {
      this.emitter.emit(
        events.error.general,
        theme.red("Error detected, but recovery mode is not enabled."),
      );
      this.emitter.emit(
        events.log.log,
        "To attempt automatic recovery, re-run with the --heal flag.",
      );
      return await this.dieOnFatal(error);
    }

    if (error.fatal) {
      return await this.dieOnFatal(error);
    }

    // Get error message
    let eMessage = error.message ? error.message : error;

    // we sanitize the error message to use it as a key in the errorCounts object
    let safeKey = JSON.stringify(error.message ? error.message : error);
    this.errorCounts[safeKey] = this.errorCounts[safeKey]
      ? this.errorCounts[safeKey] + 1
      : 1;

    this.emitter.emit(
      events.log.warn,
      theme.red("Error detected. Attempting to recover (via --heal)..."),
    );

    // Show error with source context if available
    const errorContext = this.sourceMapper.getErrorWithSourceContext(error);
    if (errorContext) {
      this.emitter.emit(events.log.warn, errorContext);
    } else {
      this.emitter.emit(events.log.markdown.static, eMessage);
    }

    this.emitter.emit(events.log.debug, error);
    this.emitter.emit(events.log.debug, error.stack);

    // if we get the same error 3 times in `run` mode, we exit
    if (this.errorCounts[safeKey] > this.errorLimit - 1) {
      this.emitter.emit(
        events.log.log,
        theme.red("Error loop detected. Exiting."),
      );
      this.emitter.emit(events.log.log, this.getErrorWithPosition(error));
      await this.summarize(eMessage);
      return await this.exit(true);
    }

    // remove this step from the execution history
    if (undo) {
      await this.popFromHistory();
    }

    // ask the AI what to do
    let image;
    if (error.attachScreenshot) {
      image = await this.system.captureScreenBase64();
    } else {
      image = null;
    }

    this.emitter.emit(events.log.log, theme.dim("thinking..."), true);

    const streamId = `error-${Date.now()}`;
    this.emitter.emit(events.log.markdown.start, streamId);

    let response = await this.sdk.req(
      "error",
      {
        description: eMessage,
        markdown,
        image,
      },
      (chunk) => {
        if (chunk.type === "data") {
          this.emitter.emit(events.log.markdown.chunk, streamId, chunk.data);
        }
      },
    );

    this.emitter.emit(events.log.markdown.end, streamId);

    // if the response worked, we try to execute the codeblocks in the response,
    // which begins the recursive process of executing codeblocks
    if (response?.data) {
      return await this.actOnMarkdown(
        response.data,
        depth,
        true,
        false,
        shouldSave,
      );
    }
  }

  // this is run after all possible codeblocks have been executed, but only at depth 0, which is the top level
  // this checks that the task is "really done" using a screenshot of the desktop state
  // it's likely that the task will not be complete and the AI will respond with more codeblocks to execute
  async check() {
    this.checkCount++;

    if (this.checkCount >= this.checkLimit) {
      this.emitter.emit(
        events.log.log,
        theme.red("Exploratory loop detected. Exiting."),
      );
      await this.summarize("Check loop detected.");
      return await this.exit(true);
    }

    this.emitter.emit(events.log.log, theme.dim("checking..."));

    // check asks the ai if the task is complete
    let thisScreenshot = await this.system.captureScreenBase64(1, false, true);
    let images = [this.lastScreenshot, thisScreenshot];
    let mousePosition = await this.system.getMousePosition();
    let activeWindow = await this.system.activeWin();

    const streamId = `check-${Date.now()}`;
    this.emitter.emit(events.log.markdown.start, streamId);

    let response = await this.sdk.req(
      "check",
      {
        tasks: this.tasks,
        images,
        mousePosition,
        activeWindow,
      },
      (chunk) => {
        if (chunk.type === "data") {
          this.emitter.emit(events.log.markdown.chunk, streamId, chunk.data);
        }
      },
    );

    this.emitter.emit(events.log.markdown.end, streamId);

    this.lastScreenshot = thisScreenshot;

    return response.data;
  }

  // command is transformed from a single yml entry generated by the AI into a JSON object
  // it is mapped via `commander` to the `commands` module so the yaml
  // parameters can be mapped to actual functions
  async runCommand(command, depth, shouldSave, pushToHistory) {
    let yml = await yaml.dump(command);
    const commandName = command.command;
    const startTime = Date.now();

    // Get current source position
    const sourcePosition = this.sourceMapper.getCurrentSourcePosition();

    // Emit command start event with source mapping
    this.emitter.emit(events.command.start, {
      command: commandName,
      depth,
      data: command,
      timestamp: startTime,
      sourcePosition: sourcePosition,
    });

    // Log current execution position for debugging
    if (this.sourceMapper.currentFileSourceMap) {
      this.emitter.emit(
        events.log.log,
        theme.dim(`${this.sourceMapper.getCurrentPositionDescription()}`),
      );
    }

    try {
      let response;

      // "run" and "if" commands are special meta commands
      // that change the flow of execution
      if (command.command == "run") {
        response = await this.embed(command.file, depth, pushToHistory);
      } else if (command.command == "if") {
        response = await this.iffy(
          command.condition,
          command.then,
          command.else,
          depth,
        );
      } else {
        response = await this.commander.run(command, depth);
      }

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Emit command success event with source mapping
      this.emitter.emit(events.command.success, {
        command: commandName,
        depth,
        data: command,
        duration,
        response,
        timestamp: endTime,
        sourcePosition: sourcePosition,
      });

      // if the result of a command contains more commands, we perform the process again
      if (response && typeof response === "string") {
        return await this.actOnMarkdown(response, depth, false, false, false);
      }
    } catch (error) {
      const endTime = Date.now();
      const duration = endTime - startTime;

      // Emit command error event with source mapping
      this.emitter.emit(events.command.error, {
        command: commandName,
        depth,
        data: command,
        error: error.message,
        duration,
        timestamp: endTime,
        sourcePosition: sourcePosition,
      });

      return await this.haveAIResolveError(
        error,
        yaml.dump({ commands: [yml] }),
        depth,
        true,
        shouldSave,
      );
    }
  }

  async executeCommands(
    commands,
    depth,
    pushToHistory = false,
    dry = false,
    shouldSave = false,
  ) {
    if (commands?.length) {
      for (const command of commands) {
        // Update current command tracking
        const commandIndex = commands.indexOf(command);
        this.sourceMapper.setCurrentCommand(commandIndex);

        if (pushToHistory) {
          this.executionHistory[
            this.executionHistory.length - 1
          ]?.commands.push(command);
        }

        if (shouldSave) {
          await this.save({ silent: true });
        }

        if (!dry) {
          await this.runCommand(command, depth, shouldSave);
        }
        let timeToComplete = (new Date().getTime() - this.lastCommand) / 1000;
        // this.emitter.emit(events.log.log, timeToComplete, 'seconds')

        this.csv.push([command.command, timeToComplete]);
        this.lastCommand = new Date().getTime();
      }
    }
  }

  // codeblocks are ```yml ... ``` blocks found in ai responses
  // this is similar to "function calling" in other ai frameworks
  // here we parse the codeblocks and execute the commands within them
  async executeCodeBlocks(
    codeblocks,
    depth,
    pushToHistory = false,
    dry = false,
    shouldSave = false,
  ) {
    depth = depth + 1;

    for (const codeblock of codeblocks) {
      let commands;

      try {
        commands = await this.parser.getCommands(codeblock);
      } catch (e) {
        // For parser errors
        return await this.haveAIResolveError(
          e,
          yaml.dump(this.parser.getYAMLFromCodeBlock(codeblock)),
          depth,
          shouldSave,
        );
      }

      await this.executeCommands(
        commands,
        depth,
        pushToHistory,
        dry,
        shouldSave,
      );
    }
  }

  // this is the main function that interacts with the ai, runs commands, and checks the results
  // notice that depth is 0 here. when this function resolves, the task is considered complete
  // notice the call to `check()` which validates the prompt is complete
  async aiExecute(
    message,
    validateAndLoop = false,
    dry = false,
    shouldSave = false,
  ) {
    this.executionHistory.push({ prompt: this.lastPrompt, commands: [] });

    if (shouldSave) {
      await this.save({ silent: true });
    }

    this.emitter.emit(events.log.debug, "kicking off exploratory loop");

    // kick everything off
    await this.actOnMarkdown(message, 0, true, dry, shouldSave);

    // this calls the "check" function to validate the task is complete"
    // the ai determines if it's complete or not
    // if it is incomplete, the ai will likely return more codeblocks to execute
    if (validateAndLoop) {
      this.emitter.emit(
        events.log.debug,
        "exploratory loop resolved, check your work",
      );

      let response = await this.check();

      let checkCodeblocks = [];
      try {
        checkCodeblocks = await this.parser.findCodeBlocks(response);
      } catch (error) {
        return await this.haveAIResolveError(error, response, 0, true, true);
      }

      this.emitter.emit(
        events.log.debug,
        `found ${checkCodeblocks.length} codeblocks`,
      );

      if (checkCodeblocks.length > 0) {
        this.emitter.emit(
          events.log.debug,
          "check thinks more needs to be done",
        );

        this.emitter.emit(events.log.log, theme.dim("not done yet!"));

        return await this.aiExecute(response, validateAndLoop);
      } else {
        this.emitter.emit(events.log.debug, "seems complete, returning");

        this.emitter.emit(events.log.log, theme.green("success!"));

        return response;
      }
    }
  }

  // reads a yaml file and interprets the variables found within it
  async loadYML(file) {
    const startTime = Date.now();

    // Emit file load start event
    this.emitter.emit(events.file.start, {
      operation: "load",
      filePath: file,
      timestamp: startTime,
    });

    let yml;

    //wrap this in try/catch so if the file doesn't exist output an error message to the user
    try {
      yml = fs.readFileSync(file, "utf-8");

      // Emit file load success event
      this.emitter.emit(events.file.load, {
        filePath: file,
        size: yml.length,
        timestamp: Date.now(),
      });
    } catch (e) {
      // Emit file error event
      this.emitter.emit(events.file.error, {
        operation: "load",
        filePath: file,
        error: e.message,
        timestamp: Date.now(),
      });

      this.emitter.emit(events.error.fatal, `File not found: ${file}`);

      await this.summarize("File not found");
      await this.exit(true);
    }
    if (!yml) {
      return {};
    }

    yml = await this.parser.validateYAML(yml);

    // Inject environment variables into any ${VAR} strings
    yml = this.parser.interpolate(yml, {
      TD_THIS_FILE: file,
      ...this.config._environment,
    });

    // Show Unreplaced Variables
    let unreplacedVars = this.parser.collectUnreplacedVariables(yml);

    // Remove all variables that start with OUTPUT- these are special
    unreplacedVars = unreplacedVars.filter((v) => {
      return !v.startsWith("OUTPUT.");
    });

    if (unreplacedVars.length > 0) {
      this.emitter.emit(
        events.error.fatal,
        `Unreplaced variables in YAML: ${unreplacedVars.join(", ")}`,
      );
    }

    let ymlObj = null;
    let sourceMap = null;
    try {
      // Parse YAML with source mapping
      const parseResult = this.sourceMapper.parseYamlWithSourceMap(yml, file);
      ymlObj = parseResult.yamlObj;
      sourceMap = parseResult.sourceMap;

      const endTime = Date.now();

      // Emit file load completion event with source mapping
      this.emitter.emit(events.file.stop, {
        operation: "load",
        filePath: file,
        duration: endTime - startTime,
        success: true,
        sourceMap: sourceMap,
        timestamp: endTime,
      });
    } catch (e) {
      const endTime = Date.now();

      // Emit file error event
      this.emitter.emit(events.file.error, {
        operation: "parse",
        filePath: file,
        error: e.message,
        duration: endTime - startTime,
        timestamp: endTime,
      });

      this.emitter.emit(events.error.fatal, e.message);

      await this.summarize("Invalid YAML");
      await this.exit(true);
    }

    return ymlObj;
  }

  // this is a rarely used command that likely doesn't need to exist
  // it's used to call /assert in interactive mode
  // @todo remove assert() command from agent.js
  async assert(expect) {
    this.analytics.track("assert");

    let task = expect;
    if (!task) {
      // set task to last value of tasks
      let task = this.tasks[this.tasks.length - 1];

      // throw error if no task
      if (!task) {
        throw new Error("No task to assert");
      }
    }

    this.emitter.emit(events.log.log, theme.dim("thinking..."), true);

    let response = `\`\`\`yaml
commands:
  - command: assert
    expect: ${expect}
\`\`\``;

    await this.aiExecute(response);

    await this.save({ silent: true });
  }

  // this function responds to the result of `promptUser()` which is the user input
  // it kicks off the exploratory loop, which is the main function that interacts with the AI
  async exploratoryLoop(
    currentTask,
    dry = false,
    validateAndLoop = false,
    shouldSave = true,
  ) {
    this.lastPrompt = currentTask;
    this.checkCount = 0;

    this.emitter.emit(events.log.debug, "exploratoryLoop called");

    this.tasks.push(currentTask);

    this.emitter.emit(events.log.log, theme.dim("thinking..."), true);

    this.lastScreenshot = await this.system.captureScreenBase64();

    const streamId = `input-${Date.now()}`;
    this.emitter.emit(events.log.markdown.start, streamId);

    let message = await this.sdk.req(
      "input",
      {
        input: currentTask,
        mousePosition: await this.system.getMousePosition(),
        activeWindow: await this.system.activeWin(),
        image: this.lastScreenshot,
      },
      (chunk) => {
        if (chunk.type === "data") {
          this.emitter.emit(events.log.markdown.chunk, streamId, chunk.data);
        }
      },
    );

    this.emitter.emit(events.log.markdown.end, streamId);

    if (message) {
      await this.aiExecute(message.data, validateAndLoop, dry, shouldSave);
      this.emitter.emit(
        events.log.debug,
        "showing prompt from exploratoryLoop response check",
      );
    }

    return;
  }

  // generate asks the AI to come up with ideas for test files
  // based on the current state of the system (primarily the current screenshot)
  // it will generate files that contain only "prompts"
  // @todo revit the generate command
  async generate(type, count, baseYaml, skipYaml = false) {
    this.emitter.emit(events.log.debug, "generate called, %s", type);

    this.emitter.emit(events.log.log, theme.dim("thinking..."), true);

    if (baseYaml && !skipYaml) {
      await this.runLifecycle("prerun");
      await this.run(baseYaml, false, false);
      await this.runLifecycle("postrun");
    }

    let image = await this.system.captureScreenBase64();

    const streamId = `generate-${Date.now()}`;
    this.emitter.emit(events.log.markdown.start, streamId);

    let message = await this.sdk.req(
      "generate",
      {
        type,
        image,
        mousePosition: await this.system.getMousePosition(),
        activeWindow: await this.system.activeWin(),
        count,
      },
      (chunk) => {
        if (chunk.type === "data") {
          this.emitter.emit(events.log.markdown.chunk, streamId, chunk.data);
        }
      },
    );

    this.emitter.emit(events.log.markdown.end, streamId);

    let testPrompts = await this.parser.findGenerativePrompts(message.data);

    // for each testPrompt
    for (const testPrompt of testPrompts) {
      // with the contents of the testPrompt
      let fileName =
        sanitizeFilename(testPrompt.name)
          .trim()
          .replace(/ /g, "-")
          .replace(/['"`]/g, "")
          .replace(/[^a-zA-Z0-9-]/g, "") // remove any non-alphanumeric chars except hyphens
          .toLowerCase() + ".yaml";
      let path1 = path.join(
        this.workingDir,
        "testdriver",
        "generate",
        fileName,
      );

      // create generate directory if it doesn't exist
      if (!fs.existsSync(path.join(this.workingDir, "generate"))) {
        fs.mkdirSync(path.join(this.workingDir, "generate"));
      }

      let list = testPrompt.steps;

      if (baseYaml && fs.existsSync(baseYaml)) {
        list.unshift({
          step: {
            command: "run",
            file: baseYaml,
          },
        });
      }
      let contents = yaml.dump({
        version: packageJson.version,
        steps: list,
      });
      fs.writeFileSync(path1, contents);
    }

    this.exit(false);
  }

  // this is the functinoality for "undo"
  async popFromHistory(fullStep) {
    this.emitter.emit(events.log.log, theme.dim("undoing..."), true);

    if (this.executionHistory.length) {
      if (fullStep) {
        this.executionHistory.pop();
      } else {
        this.executionHistory[this.executionHistory.length - 1].commands.pop();
      }
      if (
        !this.executionHistory[this.executionHistory.length - 1].commands.length
      ) {
        this.executionHistory.pop();
      }
    }
  }

  async undo() {
    this.analytics.track("undo");

    this.popFromHistory();
    await this.save();
  }

  // this allows the user to input "flattened yaml"
  // like "command='focus-application' name='Google Chrome'"
  async manualInput(commandString) {
    this.analytics.track("manual input");

    let yml = await generator.manualToYml(commandString);

    let message = `\`\`\`yaml
${yml}
\`\`\``;

    await this.aiExecute(message, false);

    await this.save({ silent: true });
  }

  // this function is responsible for starting the recursive process of executing codeblocks
  async actOnMarkdown(
    content,
    depth,
    pushToHistory = false,
    dry = false,
    shouldSave = false,
  ) {
    let codeblocks = [];
    try {
      codeblocks = await this.parser.findCodeBlocks(content);
    } catch (error) {
      pushToHistory = false;
      return await this.haveAIResolveError(
        error,
        content,
        depth,
        false,
        shouldSave,
      );
    }

    if (codeblocks.length) {
      let executions = await this.executeCodeBlocks(
        codeblocks,
        depth,
        pushToHistory,
        dry,
        shouldSave,
      );
      return executions;
    } else {
      return true;
    }
  }

  // this function is responsible for summarizing the test script that has already executed
  // it is what is saved to the `/tmp/testdriver-summary.md` file and output to the action as a summary
  async summarize(error = null) {
    this.analytics.track("summarize");

    this.emitter.emit(events.log.log, theme.dim("reviewing test..."), true);

    // let text = prompts.summarize(tasks, error);
    let image = await this.system.captureScreenBase64();

    this.emitter.emit(events.log.log, theme.dim("summarizing..."), true);

    const streamId = `summarize-${Date.now()}`;
    this.emitter.emit(events.log.markdown.start, streamId);

    let reply = await this.sdk.req(
      "summarize",
      {
        image,
        error: error?.toString(),
        tasks: this.tasks,
      },
      (chunk) => {
        if (chunk.type === "data") {
          this.emitter.emit(events.log.markdown.chunk, streamId, chunk.data);
        }
      },
    );

    this.emitter.emit(events.log.markdown.end, streamId);

    // Only write summary to file if --summary option was provided
    if (this.resultFile) {
      // Ensure the output directory exists
      const outputDir = path.dirname(this.resultFile);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      fs.writeFileSync(this.resultFile, reply.data);
      this.emitter.emit(
        events.log.log,
        theme.dim(`Summary written to: ${this.resultFile}`),
      );
    } else {
      const tmpFile = path.join(os.tmpdir(), "testdriver-summary.md");
      fs.writeFileSync(tmpFile, reply?.data);
      this.emitter.emit(
        events.log.log,
        theme.dim(`Summary written to: ${tmpFile}`),
      );
    }
  }

  // this function is responsible for saving the regression test script to a file
  async save({ filepath = this.thisFile, silent = false } = {}) {
    const startTime = Date.now();

    // Emit file save start event
    this.emitter.emit(events.file.start, {
      operation: "save",
      filePath: filepath,
      timestamp: startTime,
    });

    this.analytics.track("save", { silent });

    if (!this.executionHistory.length) {
      // Emit file save completion event for empty history
      this.emitter.emit(events.file.stop, {
        operation: "save",
        filePath: filepath,
        duration: Date.now() - startTime,
        success: true,
        reason: "empty_history",
        timestamp: Date.now(),
      });
      return;
    }

    // write reply to /tmp/testdriver-summary.md
    let regression = await generator.dumpToYML(
      this.executionHistory,
      this.session,
    );
    try {
      fs.writeFileSync(filepath, regression);

      const endTime = Date.now();

      // Emit file save success event
      this.emitter.emit(events.file.save, {
        filePath: filepath,
        size: regression.length,
        timestamp: endTime,
      });

      // Emit file save completion event
      this.emitter.emit(events.file.stop, {
        operation: "save",
        filePath: filepath,
        duration: endTime - startTime,
        success: true,
        timestamp: endTime,
      });
    } catch (e) {
      const endTime = Date.now();

      // Emit file save error event
      this.emitter.emit(events.file.error, {
        operation: "save",
        filePath: filepath,
        error: e.message,
        duration: endTime - startTime,
        timestamp: endTime,
      });

      this.emitter.emit(events.error.fatal, e.message);
    }

    if (!silent) {
      this.emitter.emit(
        events.log.markdown.static,
        `Current test script:

\`\`\`yaml
${regression}
\`\`\``,
      );

      if (!silent) {
        this.emitter.emit(events.log.log, theme.dim(`saved as ${filepath}`));
      }
    }

    return;
  }

  async runRawYML(yml) {
    const tmp = require("tmp");
    let tmpobj = tmp.fileSync();

    let decoded = decodeURIComponent(yml);

    // parse the yaml
    let ymlObj = null;
    try {
      ymlObj = await yaml.load(decoded);
    } catch (e) {
      this.emitter.emit(events.error.fatal, e);
    }

    // add the root key steps: with array of commands:
    if (ymlObj && !ymlObj.steps) {
      ymlObj = {
        version: packageJson.version,
        steps: [ymlObj],
      };
    }

    // write the yaml to a file
    fs.writeFileSync(tmpobj.name, yaml.dump(ymlObj));

    // and run it with run()

    await this.runLifecycle("prerun");
    await this.run(tmpobj.name, false, false);
    await this.runLifecycle("postrun");
  }

  // this will load a regression test from a file location
  // it parses the markdown file and executes the codeblocks exactly as if they were
  // generated by the AI in a single prompt
  async run(file = this.thisFile, shouldSave = false, shouldExit = true) {
    this.emitter.emit(events.log.log, theme.cyan(`running ${file}...`));

    let ymlObj = await this.loadYML(file);

    // Store source mapping for current file
    const parseResult = this.sourceMapper.parseYamlWithSourceMap(
      fs.readFileSync(file, "utf-8"),
      file,
    );
    this.sourceMapper.setCurrentContext(file, parseResult.sourceMap, -1, -1);

    if (ymlObj.version) {
      let valid = isValidVersion(ymlObj.version);
      if (!valid) {
        this.emitter.emit(
          events.log.warn,
          theme.yellow(`Version mismatch detected!`),
        );
        this.emitter.emit(
          events.log.warn,
          theme.yellow(`Running a test created with v${ymlObj.version}.`),
        );
        this.emitter.emit(
          events.log.warn,
          theme.yellow(
            `The local testdriverai version is v${packageJson.version}.`,
          ),
        );
      }
    }

    this.executionHistory = [];

    if (!ymlObj.steps || !ymlObj.steps.length) {
      this.emitter.emit(
        events.log.log,
        theme.red("No steps found in the YAML file"),
      );
      await this.exit(true, shouldSave, true);
    }

    for (const step of ymlObj.steps) {
      const stepIndex = ymlObj.steps.indexOf(step);
      const stepStartTime = Date.now();

      // Update current step tracking
      this.sourceMapper.setCurrentStep(stepIndex);

      // Get source position for current step
      const sourcePosition = this.sourceMapper.getCurrentSourcePosition();

      // Emit step start event with source mapping
      this.emitter.emit(events.step.start, {
        stepIndex,
        prompt: step.prompt,
        commandCount: step.commands ? step.commands.length : 0,
        timestamp: stepStartTime,
        sourcePosition: sourcePosition,
      });

      this.emitter.emit(events.log.log, ``, null);
      this.emitter.emit(
        events.log.log,
        theme.yellow(`> ${step.prompt || "no prompt"}`),
        null,
      );

      try {
        if (!step.commands && !step.prompt) {
          this.emitter.emit(
            events.log.log,
            theme.red("No commands or prompt found"),
          );

          this.emitter.emit(events.step.error, {
            stepIndex,
            prompt: step.prompt,
            error: "No commands or prompt found",
            timestamp: Date.now(),
          });

          await this.exit(true, shouldSave, true);
        } else if (!step.commands) {
          this.emitter.emit(
            events.log.log,
            theme.yellow("No commands found, running exploratory"),
          );
          await this.exploratoryLoop(step.prompt, false, true, shouldSave);
        } else {
          await this.executeCommands(step.commands, 0, true, false, shouldSave);
        }

        const stepEndTime = Date.now();
        const stepDuration = stepEndTime - stepStartTime;

        // Emit step success event with source mapping
        this.emitter.emit(events.step.success, {
          stepIndex,
          prompt: step.prompt,
          commandCount: step.commands ? step.commands.length : 0,
          duration: stepDuration,
          timestamp: stepEndTime,
          sourcePosition: sourcePosition,
        });

        if (shouldSave) {
          await this.save({ silent: true });
        }
      } catch (error) {
        const stepEndTime = Date.now();
        const stepDuration = stepEndTime - stepStartTime;

        // Emit step error event with source mapping
        this.emitter.emit(events.step.error, {
          stepIndex,
          prompt: step.prompt,
          error: error.message,
          duration: stepDuration,
          timestamp: stepEndTime,
          sourcePosition: sourcePosition,
        });

        throw error; // Re-throw to maintain existing error handling
      }
    }

    if (shouldSave) {
      await this.save({ filepath: file, silent: false });
    }
    if (shouldExit) {
      await this.summarize();
      await this.exit(false, shouldSave, true);
    }
  }

  async iffy(condition, then, otherwise, depth) {
    this.analytics.track("if", { condition });

    this.emitter.emit(
      events.log.log,
      generator.jsonToManual({ command: "if", condition }),
    );

    try {
      await this.commands.assert(condition, false);
      return await this.executeCommands(then, ++depth);
      // eslint-disable-next-line no-unused-vars
    } catch (error) {
      return await this.executeCommands(otherwise, ++depth);
    }
  }

  async embed(file, depth, pushToHistory) {
    this.analytics.track("embed", { file });

    this.emitter.emit(
      events.log.log,
      generator.jsonToManual({ command: "run", file }),
    );

    depth = depth + 1;

    this.emitter.emit(events.log.log, `${file} (start)`);

    // Use the new helper method to resolve file paths relative to testdriver directory
    const currentFilePath = this.sourceMapper.currentFilePath || this.thisFile;

    // if the file is not an absolute path, resolve it using the new helper
    if (!path.isAbsolute(file)) {
      file = this.resolveTestDriverRelativePath(currentFilePath, file);
    }

    // check if the file exists
    if (!fs.existsSync(file)) {
      throw `Embedded file not found: ${file}`;
    }

    let ymlObj = await this.loadYML(file);

    // Store current source mapping state
    const previousContext = this.sourceMapper.saveContext();

    // Set up source mapping for embedded file
    const parseResult = this.sourceMapper.parseYamlWithSourceMap(
      fs.readFileSync(file, "utf-8"),
      file,
    );
    this.sourceMapper.setCurrentContext(file, parseResult.sourceMap, -1, -1);

    try {
      for (const step of ymlObj.steps) {
        const stepIndex = ymlObj.steps.indexOf(step);
        this.sourceMapper.setCurrentStep(stepIndex);

        if (!step.commands && !step.prompt) {
          this.emitter.emit(
            events.log.log,
            theme.red("No commands or prompt found"),
          );
          await this.exit(true);
        } else if (!step.commands) {
          this.emitter.emit(
            events.log.log,
            theme.yellow("No commands found, running exploratory"),
          );
          await this.exploratoryLoop(step.prompt, false, true, false);
        } else {
          await this.executeCommands(step.commands, depth, pushToHistory);
        }
      }
    } finally {
      // Restore previous source mapping state
      this.sourceMapper.restoreContext(previousContext);
    }

    this.emitter.emit(events.log.log, `${file} (end)`);
  }

  // Returns sandboxId to use (either from file if recent, or null)
  getRecentSandboxId() {
    const lastSandboxFile = path.join(
      os.homedir(),
      ".testdriverai-last-sandbox",
    );
    if (fs.existsSync(lastSandboxFile)) {
      try {
        const stats = fs.statSync(lastSandboxFile);
        const mtime = new Date(stats.mtime);
        const now = new Date();
        const diffMinutes = (now - mtime) / (1000 * 60);
        if (diffMinutes < 30) {
          const lastSandboxId = fs
            .readFileSync(lastSandboxFile, "utf-8")
            .trim();
          if (lastSandboxId) {
            return lastSandboxId;
          }
        }
      } catch {
        // ignore errors
      }
    }
    return null;
  }

  saveLastSandboxId(instanceId) {
    const lastSandboxFile = path.join(
      os.homedir(),
      ".testdriverai-last-sandbox",
    );
    try {
      fs.writeFileSync(lastSandboxFile, instanceId, { encoding: "utf-8" });
    } catch {
      // ignore errors
    }
  }

  clearRecentSandboxId() {
    const lastSandboxFile = path.join(
      os.homedir(),
      ".testdriverai-last-sandbox",
    );
    try {
      if (fs.existsSync(lastSandboxFile)) {
        fs.unlinkSync(lastSandboxFile);
      }
    } catch {
      // ignore errors
    }
  }
  async buildEnv(options = {}) {
    // If instance already exists, do not build environment again
    if (this.instance) {
      this.emitter.emit(
        events.log.log,
        theme.dim("- sandbox instance already exists, skipping launch."),
      );
      return;
    }

    let { headless = false, heal, new: createNew = false } = options;

    // If CI environment variable is true, always create a new sandbox
    if (this.config.CI) {
      createNew = true;
      this.emitter.emit(
        events.log.log,
        theme.dim("CI environment detected, will create a new sandbox"),
      );
    }

    if (heal) this.healMode = heal;

    // If createNew flag is set, clear the recent sandbox file to force creating a new sandbox
    if (createNew) {
      this.clearRecentSandboxId();
      if (!this.config.CI) {
        this.emitter.emit(
          events.log.log,
          theme.dim("-- `new` flag detected, will create a new sandbox"),
        );
      }
    }

    // order is important!
    await this.connectToSandboxService();

    const recentId = createNew ? null : this.getRecentSandboxId();

    // Set sandbox ID for reconnection (only if not creating new and recent ID exists)
    if (!createNew && recentId) {
      this.emitter.emit(
        events.log.log,
        theme.dim(`- using recent sandbox: ${recentId}`),
      );
      this.sandboxId = recentId;
    } else if (!createNew) {
      this.emitter.emit(
        events.log.log,
        theme.dim(`- no recent sandbox found, creating a new one.`),
      );
    }

    // Only attempt to connect to existing sandbox if not in CI mode and not creating new
    if (this.sandboxId && !this.config.CI && !createNew) {
      // Attempt to connect to known instance
      this.emitter.emit(
        events.log.log,
        theme.dim(`- connecting to sandbox ${this.sandboxId}...`),
      );

      try {
        let instance = await this.connectToSandboxDirect(
          this.sandboxId,
          true, // always persist by default
        );

        this.instance = instance;

        await this.renderSandbox(instance, headless);
        await this.newSession();
        return;
      } catch (error) {
        // But if it fails because the machine 404s, fall-through to `createNewSandbox()`
        if (error?.name !== "InvalidInstanceID.NotFound") {
          throw error;
        }
      }
    }

    this.emitter.emit(events.log.log, theme.dim(`- creating new sandbox...`));
    this.emitter.emit(
      events.log.log,
      theme.dim(`  (this can take between 10 - 240 seconds)`),
    );
    // We don't have resiliency/retries baked in, so let's at least give it 1 attempt
    // to see if that fixes the issue.
    let newSandbox = await this.createNewSandbox().catch(() => {
      this.emitter.emit(
        events.log.log,
        theme.dim(`  (double-checking sandbox availability)`),
      );

      return this.createNewSandbox();
    });

    this.saveLastSandboxId(newSandbox.sandbox.instanceId);
    let instance = await this.connectToSandboxDirect(
      newSandbox.sandbox.instanceId,
      true, // always persist by default
    );
    this.instance = instance;
    await this.renderSandbox(instance, headless);
    await this.newSession();
    await this.runLifecycle("provision");
  }

  async start() {
    try {
      this.emitter.emit(
        events.log.log,
        theme.green(`Howdy! I'm TestDriver v${packageJson.version}`),
      );
      // Start the debugger server as early as possible to ensure event listeners are attached
      if (!debuggerStarted) {
        debuggerStarted = true; // Prevent multiple starts, especially when running test in parallel
        this.emitter.emit(
          events.log.log,
          theme.green(`Starting debugger server...`),
        );
        debuggerProcess = await createDebuggerProcess(
          this.config,
          this.emitter,
        );
      }
      this.debuggerUrl = debuggerProcess.url || null; // Store the debugger URL
      this.emitter.emit(events.log.log, `This is beta software!`);
      this.emitter.emit(
        events.log.log,
        theme.yellow(`Join our Forums for help`),
      );
      this.emitter.emit(events.log.log, `https://forums.testdriver.ai`);

      // make testdriver directory if it doesn't exist
      let testdriverFolder = path.join(this.workingDir);
      if (!fs.existsSync(testdriverFolder)) {
        fs.mkdirSync(testdriverFolder);
        // log
        this.emitter.emit(
          events.log.log,
          theme.dim(`Created testdriver directory: ${testdriverFolder}`),
        );
      }

      // if the directory for thisFile doesn't exist, create it
      if (this.cliArgs.command !== "sandbox") {
        const dir = path.dirname(this.thisFile);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
          this.emitter.emit(
            events.log.log,
            theme.dim(`Created directory ${dir}`),
          );
        }

        // if thisFile doesn't exist, create it
        // thisFile def to testdriver/testdriver.yaml, during init, it just creates an empty file
        if (!fs.existsSync(this.thisFile)) {
          fs.writeFileSync(this.thisFile, "");
          this.emitter.emit(
            events.log.log,
            theme.dim(`Created ${this.thisFile}`),
          );
        }
      }

      if (this.config.TD_API_KEY) {
        await this.sdk.auth();
      }

      if (this.cliArgs.command !== "sandbox") {
        this.emitter.emit(
          events.log.log,
          theme.dim(`Working on ${this.thisFile}`),
        );

        this.loadYML(this.thisFile);
      }

      this.analytics.track("command", {
        command: this.cliArgs.command,
        file: this.thisFile,
      });

      // Dynamically handle all available commands (except edit which is handled by CLI)
      const availableCommands = Object.keys(this.getCommandDefinitions());
      if (
        availableCommands.includes(this.cliArgs.command) &&
        this.cliArgs.command !== "edit"
      ) {
        await this.executeUnifiedCommand(
          this.cliArgs.command,
          this.cliArgs.args,
          this.cliArgs.options,
          this.cliArgs.options._optionValues,
        );
      } else if (this.cliArgs.command !== "edit") {
        this.emitter.emit(
          events.error.fatal,
          `Unknown command: ${this.cliArgs.command}`,
        );
        await this.exit(true);
      }
    } catch (error) {
      this.emitter.emit(events.error.fatal, error.message || error);
      await this.exit(true);
    }
  }

  async renderSandbox(instance, headless = false) {
    if (!headless) {
      let url =
        "http://" + instance.ip + ":" + instance.vncPort + "/vnc_lite.html";

      let data = {
        resolution: this.config.TD_RESOLUTION,
        url: url,
        token: "V3b8wG9",
      };

      const encodedData = encodeURIComponent(JSON.stringify(data));

      // Use the debugger URL instead of the VNC URL
      const urlToOpen = `${this.debuggerUrl}?data=${encodedData}`;

      this.emitter.emit(events.showWindow, urlToOpen);
    }
  }

  async connectToSandboxService() {
    this.emitter.emit(
      events.log.log,
      theme.gray(`- establishing connection...`),
    );
    await this.sandbox.boot(this.config.TD_API_ROOT);
    this.emitter.emit(events.log.log, theme.gray(`- authenticating...`));
    await this.sandbox.auth(this.config.TD_API_KEY);
  }

  async connectToSandboxDirect(sandboxId, persist = false) {
    this.emitter.emit(events.log.log, theme.gray(`- connecting...`));
    let instance = await this.sandbox.connect(sandboxId, persist);
    return instance;
  }

  async createNewSandbox() {
    let instance = await this.sandbox.send({
      type: "create",
      resolution: this.config.TD_RESOLUTION,
      ci: this.config.CI,
    });
    return instance;
  }

  async newSession() {
    // should be start of new session
    const sessionRes = await this.sdk.req("session/start", {
      systemInformationOsInfo: await this.system.getSystemInformationOsInfo(),
      mousePosition: await this.system.getMousePosition(),
      activeWindow: await this.system.activeWin(),
    });

    if (!sessionRes) {
      throw new Error(
        "Unable to start TestDriver session.  Check your network connection or restart the CLI.",
      );
    }

    this.session.set(sessionRes.data.id);
  }

  // Helper method to find testdriver directory by traversing up from a file path
  findTestDriverDirectory(filePath) {
    // Start from the directory containing the file, or use workingDir as fallback
    let currentDir = filePath
      ? path.dirname(path.resolve(filePath))
      : this.workingDir;

    while (currentDir !== path.dirname(currentDir)) {
      // Continue until we reach the root
      const testdriverPath = path.join(currentDir, "testdriver");
      if (
        fs.existsSync(testdriverPath) &&
        fs.statSync(testdriverPath).isDirectory()
      ) {
        return testdriverPath;
      }
      currentDir = path.dirname(currentDir);
    }

    // Fallback to workingDir/testdriver if not found
    return path.join(this.workingDir, "testdriver");
  }

  // Helper method to resolve file paths relative to the testdriver directory
  // This handles both snippets and other relative files that should be resolved
  // relative to the nearest testdriver directory
  resolveTestDriverRelativePath(filePath, relativePath) {
    // If it's already an absolute path, return as-is
    if (path.isAbsolute(relativePath)) {
      return relativePath;
    }

    // Check if this looks like a snippet or lifecycle reference
    if (
      relativePath.startsWith("snippets/") ||
      relativePath.startsWith("lifecycle/")
    ) {
      // First, check if there's a local directory in the same directory as the current file
      if (filePath) {
        const currentFileDir = path.dirname(path.resolve(filePath));
        const localPath = path.join(currentFileDir, relativePath);

        if (fs.existsSync(localPath)) {
          return localPath;
        }
      }

      // If no local file found, fall back to the testdriver directory
      const testdriverDir = this.findTestDriverDirectory(filePath);
      return path.join(testdriverDir, relativePath);
    }

    // For other relative paths, resolve relative to the current file's directory
    if (filePath) {
      return path.resolve(path.dirname(filePath), relativePath);
    }

    // Fallback to workingDir
    return path.resolve(this.workingDir, relativePath);
  }

  async runLifecycle(lifecycleName) {
    // Use the current file path from sourceMapper to find the lifecycle directory
    // If sourceMapper doesn't have a current file, use thisFile which should be the file being run
    let currentFilePath = this.sourceMapper.currentFilePath || this.thisFile;
    // Ensure we have an absolute path
    if (currentFilePath && !path.isAbsolute(currentFilePath)) {
      currentFilePath = path.resolve(this.workingDir, currentFilePath);
    }
    let lifecycleFile = null;

    // First, check if there's a local lifecycle directory in the same directory as the current file
    if (currentFilePath) {
      const currentFileDir = path.dirname(currentFilePath);
      const localLifecycleDir = path.join(currentFileDir, "lifecycle");
      const localLifecycleFile = path.join(
        localLifecycleDir,
        `${lifecycleName}.yaml`,
      );
      // If there's a local lifecycle directory, only look there (don't fall back to global)
      if (
        fs.existsSync(localLifecycleDir) &&
        fs.statSync(localLifecycleDir).isDirectory()
      ) {
        if (fs.existsSync(localLifecycleFile)) {
          lifecycleFile = localLifecycleFile;
        }
        // Stop here - don't fall back to global if local lifecycle directory exists
      } else {
        // Only fall back to global if there's no local lifecycle directory
        const testdriverDir = this.findTestDriverDirectory(currentFilePath);
        const globalLifecycleFile = path.join(
          testdriverDir,
          "lifecycle",
          `${lifecycleName}.yaml`,
        );
        if (fs.existsSync(globalLifecycleFile)) {
          lifecycleFile = globalLifecycleFile;
        }
      }
    }
    if (lifecycleFile) {
      await this.run(lifecycleFile, false, false);
    }
  } // Unified command definitions that work for both CLI and interactive modes
  getCommandDefinitions() {
    return createCommandDefinitions(this);
  }

  // Execute a unified command
  async executeUnifiedCommand(commandName, args = {}, options = {}) {
    const commands = this.getCommandDefinitions();
    const command = commands[commandName];

    if (!command) {
      throw new Error(`Unknown command: ${commandName}`);
    }

    // Convert args array to object if needed
    const argsObj = {};
    if (Array.isArray(args)) {
      // Get argument definitions from the command
      const argDefs = command.args ? Object.values(command.args) : [];
      const argNames = command.args ? Object.keys(command.args) : [];

      // Handle both positional args (/run myfile) and named args (/run file=myfile)
      args.forEach((arg, index) => {
        if (typeof arg === "string" && arg.includes("=")) {
          // Named argument: file=myfile or path=myfile
          const [key, value] = arg.split("=", 2);
          // Support both 'file' and 'path' for the run command
          if (commandName === "run" && key === "path") {
            argsObj["file"] = value;
          } else {
            argsObj[key] = value;
          }
        } else {
          // Positional argument: myfile
          const argName = argNames[index];
          if (argName) {
            const argDef = argDefs[index];
            if (argDef && argDef.variadic) {
              argsObj[argName] = args.slice(index);
            } else {
              argsObj[argName] = arg;
            }
          }
        }
      });

      // Apply defaults for any missing arguments
      argNames.forEach((argName, index) => {
        const argDef = argDefs[index];
        if (argsObj[argName] === undefined && argDef && argDef.default) {
          argsObj[argName] = argDef.default;
        }
      });
    } else {
      Object.assign(argsObj, args);
    }

    // Move environment setup and special handling here
    if (["edit", "run"].includes(commandName)) {
      await this.buildEnv(options);
    }

    if (commandName === "run") {
      this.errorLimit = 100;
    }
    await command.handler(argsObj, options);
  }
}

module.exports = TestDriverAgent;
