const BaseCommand = require("../lib/base.js");
const { createCommandDefinitions } = require("../../../agent/interface.js");
const { initProject } = require("../../../lib/init-project.js");
const { CLIENTS, detectClients } = require("../../../lib/install-clients.js");
const fs = require("fs");
const path = require("path");
const chalk = require("chalk");
const readline = require("readline");
const os = require("os");
const { execSync } = require("child_process");

// Load .env file for CLI usage (TD_API_ROOT, etc.)
require("dotenv").config();

// API configuration
const channelConfig = require("../../../lib/resolve-channel.js");
const API_BASE_URL = process.env.TD_API_ROOT || channelConfig.channels[channelConfig.active];
const POLL_INTERVAL = 5000; // 5 seconds
const POLL_TIMEOUT = 900000; // 15 minutes

/**
 * Init command - scaffolds Vitest SDK example tests for TestDriver
 */
class InitCommand extends BaseCommand {
  async run() {
    const { flags } = await this.parse(InitCommand);

    console.log(chalk.cyan("\n🚀 Initializing TestDriver project...\n"));

    await this.setupPackageJson();
    await this.createVitestExample();
    await this.createAgentDocs();
    await this.createGitHubWorkflow();
    await this.createGitignore();
    await this.installDependencies();
    // Prompt for API key first
    const apiKey = await this.promptForApiKey();

    // Determine which AI clients to wire up: from --client flag, or interactively.
    let clients;
    if (flags.client) {
      clients = flags.client
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
    } else {
      clients = await this.promptForClients();
    }

    // Helper to print progress messages with appropriate colors
    const printProgress = (msg) => {
      if (msg.startsWith("✓")) {
        console.log(chalk.green(`  ${msg}`));
      } else if (msg.startsWith("⚠") || msg.startsWith("ℹ")) {
        console.log(chalk.yellow(`  ${msg}`));
      } else if (msg.startsWith("⊘")) {
        console.log(chalk.gray(`  ${msg}`));
      } else {
        console.log(`  ${msg}`);
      }
    };

    // Run the shared init logic with real-time progress output
    const result = await initProject({
      targetDir: process.cwd(),
      apiKey: apiKey,
      skipInstall: false,
      // --no-sample-test sets flags["sample-test"] to false
      skipSampleTest: flags["sample-test"] === false,
      clients: clients && clients.length ? clients : undefined,
      channel: channelConfig.active,
      onProgress: printProgress,
    });

    // Print errors if any
    for (const err of result.errors) {
      console.log(chalk.yellow(`  ⚠️  ${err}`));
    }

    // Handle shell profile for API key (CLI-specific feature)
    if (apiKey && apiKey.trim()) {
      this.addToShellProfile("TD_API_KEY", apiKey.trim());
    }

    if (result.success) {
      console.log(chalk.green("\n✅ Project initialized successfully!\n"));
      this.printNextSteps();
      process.exit(0);
    } else {
      console.log(chalk.red("\n❌ Project initialization completed with errors.\n"));
      process.exit(1);
    }
  }

  /**
   * Prompt user for API key and save to .env
   * @returns {Promise<string|null>} The API key or null if skipped
   */
  async promptForApiKey() {
    const envPath = path.join(process.cwd(), ".env");

    // Check if .env already exists with a valid TD_API_KEY value
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, "utf8");
      // Match TD_API_KEY= that's not commented out and has a real value (not empty or placeholder)
      const apiKeyMatch = envContent.match(/^TD_API_KEY=(.+)$/m);
      if (apiKeyMatch) {
        const value = apiKeyMatch[1].trim();
        // Skip only if there's a real value (not empty or placeholder text)
        if (value && value !== "your_api_key" && !value.startsWith("<") && !value.startsWith("$")) {
          console.log(
            chalk.gray("\n  API key already configured in .env, skipping...\n"),
          );
          return null;
        }
      }
    }

    console.log(chalk.cyan("  Setting up your TestDriver API key...\n"));

    // Ask user how they want to authenticate
    const choice = await this.askChoice(
      "  How would you like to authenticate?\n",
      [
        { key: "1", label: "Login with browser", description: "(recommended)" },
        { key: "2", label: "Enter API key manually", description: "" },
      ],
    );

    if (choice === "1") {
      // Browser login flow
      try {
        const apiKey = await this.browserLogin();
        if (apiKey) {
          console.log(chalk.green("\n  ✓ Logged in successfully!\n"));
          return apiKey;
        }
      } catch (error) {
        console.log(chalk.yellow(`\n  ⚠️  Browser login failed: ${error.message}\n`));
        console.log(chalk.gray("  Falling back to manual API key entry...\n"));
      }
    }

    // Manual API key entry
    console.log(
      chalk.gray("  Get your API key from: https://console.testdriver.ai/team\n"),
    );

    // Ask if user wants to open the browser
    const shouldOpen = await this.askYesNo(
      "  Open API keys page in browser? (Y/n): ",
    );
    if (shouldOpen) {
      try {
        const open = (await import("open")).default;
        await open("https://console.testdriver.ai/team");
        console.log(chalk.gray("  Opening browser...\n"));
      } catch (error) {
        console.log(
          chalk.yellow("  ⚠️  Could not open browser automatically\n"),
        );
      }
    }

    // Prompt for API key with hidden input
    const apiKey = await this.promptHidden(
      "  Enter your API key (input will be hidden): ",
    );

    if (apiKey && apiKey.trim()) {
      console.log(chalk.green("\n  ✓ API key will be saved\n"));
      return apiKey.trim();
    } else {
      console.log(
        chalk.yellow(
          "\n  ⚠️  No API key entered. You can add it later to .env:\n",
        ),
      );
      console.log(chalk.gray("     TD_API_KEY=your_api_key\n"));
      return null;
    }
  }

  /**
   * Prompt the user to select which AI clients to install TestDriver into.
   * Returns an array of client ids (possibly empty).
   * @returns {Promise<string[]>}
   */
  async promptForClients() {
    const ids = Object.keys(CLIENTS);
    const detected = new Set(detectClients(process.cwd()));

    // Non-interactive stdin (CI, piped input, no TTY): don't prompt — fall back
    // to detected clients so init can still scaffold all files unattended.
    if (!process.stdin.isTTY) {
      return [...detected];
    }

    console.log(chalk.cyan("\n  Which AI clients should TestDriver be installed into?\n"));
    ids.forEach((id, i) => {
      const c = CLIENTS[id];
      const tag = detected.has(id) ? chalk.green(" (detected)") : "";
      const web = c.type === "web" ? chalk.gray(" — web, manual steps") : "";
      console.log(`  ${chalk.cyan(i + 1)}. ${c.label}${tag}${web}`);
    });
    console.log(`  ${chalk.cyan("a")}. All of the above`);
    console.log(
      chalk.gray(
        "\n  Enter numbers separated by commas (e.g. 1,3), 'a' for all, or press Enter to skip.\n",
      ),
    );

    const answer = await new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      // Default to detected clients if any, else skip.
      const defaultHint = detected.size
        ? ` [${[...detected].map((d) => ids.indexOf(d) + 1).join(",")}]`
        : "";
      let answered = false;
      rl.question(`  Select clients${defaultHint}: `, (a) => {
        answered = true;
        rl.close();
        resolve(a.trim());
      });
      // If stdin closes (EOF) before a line is entered, the question callback
      // never fires — resolve empty so init doesn't hang.
      rl.on("close", () => {
        if (!answered) resolve("");
      });
    });

    if (!answer) {
      // Enter pressed: use detected clients if any, otherwise none.
      return [...detected];
    }
    if (answer.toLowerCase() === "a" || answer.toLowerCase() === "all") {
      return ["all"];
    }
    const selected = answer
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= ids.length)
      .map((n) => ids[n - 1]);
    return selected;
  }

  /**
   * Browser-based login flow using device code
   * @returns {Promise<string>} The API key
   */
  async browserLogin() {
    // Step 1: Create device code
    process.stdout.write(chalk.gray("  Requesting authorization code..."));
    
    const createResponse = await fetch(`${API_BASE_URL}/auth/device/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    if (!createResponse.ok) {
      throw new Error("Failed to create device code");
    }

    const { device_code, verification_uri, expires_in, interval } = await createResponse.json();
    console.log(chalk.green(" done\n"));

    // Step 2: Open browser
    console.log(chalk.cyan(`  Opening browser to authorize CLI...\n`));
    console.log(chalk.gray(`  If browser doesn't open, visit:\n  ${verification_uri}\n`));

    try {
      const open = (await import("open")).default;
      await open(verification_uri);
    } catch (error) {
      // Browser didn't open, user can use the URL manually
    }

    // Step 3: Poll for token
    const pollInterval = (interval || 5) * 1000;
    const timeout = (expires_in || 900) * 1000;
    const startTime = Date.now();

    process.stdout.write(chalk.gray("  Waiting for authorization..."));
    
    // Start spinner
    const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let spinnerIndex = 0;
    const spinnerInterval = setInterval(() => {
      process.stdout.write(`\r  Waiting for authorization... ${spinnerFrames[spinnerIndex]}`);
      spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
    }, 100);

    try {
      while (Date.now() - startTime < timeout) {
        await this.sleep(pollInterval);

        const tokenResponse = await fetch(`${API_BASE_URL}/auth/device/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceCode: device_code }),
        });

        const data = await tokenResponse.json();

        if (tokenResponse.ok && data.apiKey) {
          clearInterval(spinnerInterval);
          process.stdout.write("\r  Waiting for authorization... " + chalk.green("✓") + "\n");
          return data.apiKey;
        }

        if (data.error === "expired_token") {
          clearInterval(spinnerInterval);
          throw new Error("Authorization timed out. Please try again.");
        }

        // authorization_pending - continue polling
      }

      clearInterval(spinnerInterval);
      throw new Error("Authorization timed out. Please try again.");
    } catch (error) {
      clearInterval(spinnerInterval);
      process.stdout.write("\n");
      throw error;
    }
  }

  /**
   * Ask user to choose from a list of options
   */
  async askChoice(question, options) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      console.log(question);
      for (const opt of options) {
        const desc = opt.description ? chalk.gray(` ${opt.description}`) : "";
        console.log(`  ${chalk.cyan(opt.key)}. ${opt.label}${desc}`);
      }
      console.log("");

      rl.question("  Enter choice [1]: ", (answer) => {
        rl.close();
        const normalized = answer.trim() || "1";
        resolve(normalized);
      });
    });
  }

  /**
   * Sleep for a given number of milliseconds
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Prompt for hidden input (like password)
   */
  async promptHidden(question) {
    return new Promise((resolve) => {
      process.stdout.write(question);

      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");

      let input = "";

      const onData = (char) => {
        // Handle Ctrl+C
        if (char === "\u0003") {
          stdin.setRawMode(wasRaw);
          process.exit();
        }
        // Handle Enter
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(wasRaw);
          stdin.removeListener("data", onData);
          stdin.pause();
          console.log(""); // New line after hidden input
          resolve(input);
          return;
        }
        // Handle Backspace
        if (char === "\u007F" || char === "\b") {
          input = input.slice(0, -1);
          return;
        }
        // Add character to input (but don't echo it)
        input += char;
      };

      stdin.on("data", onData);
    });
  }

  /**
   * Copy agent documentation files to agents directory
   */
  async createAgentDocs() {
    const agentsDir = path.join(process.cwd(), "agents");
    const testdriverDocPath = path.join(agentsDir, "testdriver.md");
    const copilotDocPath = path.join(agentsDir, "copilot-instructions.md");
    
    // Find the source agents.mdx file in the package
    const sourceDocPath = path.join(__dirname, "../../../docs/v7/_drafts/agents.mdx");
    
    if (!fs.existsSync(sourceDocPath)) {
      console.log(chalk.yellow("  ⚠️  Agent documentation not found, skipping..."));
      return;
    }

    // Create agents directory if it doesn't exist
    if (!fs.existsSync(agentsDir)) {
      fs.mkdirSync(agentsDir, { recursive: true });
      console.log(chalk.gray(`  Created directory: ${agentsDir}`));
    }

    // Always copy to agents/testdriver.md
    fs.copyFileSync(sourceDocPath, testdriverDocPath);
    console.log(chalk.green(`  Created agent docs: ${testdriverDocPath}`));

    // Copy to agents/copilot-instructions.md only if it doesn't exist
    if (!fs.existsSync(copilotDocPath)) {
      fs.copyFileSync(sourceDocPath, copilotDocPath);
      console.log(chalk.green(`  Created agent docs: ${copilotDocPath}`));
    } else {
      console.log(chalk.gray("  agents/copilot-instructions.md already exists, skipping..."));
    }
  }

  /**
   * Create or update .gitignore to include .env
   */
  addToShellProfile(key, value) {
    if (process.platform === "win32") {
      // On Windows, set a persistent user environment variable via setx
      try {
        execSync(`setx ${key} "${value}"`, { stdio: "ignore" });
        console.log(
          chalk.green(`  ✓ Set ${key} as user environment variable`),
        );
        console.log(
          chalk.gray(`    Restart your terminal for changes to take effect\n`),
        );
      } catch (error) {
        console.log(
          chalk.yellow(`  ⚠️  Could not set ${key} via setx. You can set it manually:\n`),
        );
        console.log(chalk.gray(`     setx ${key} "your_api_key"\n`));
      }
      return;
    }

    // Unix: append export to shell profile
    const shell = process.env.SHELL || "/bin/bash";
    const home = os.homedir();
    let profilePath;

    if (shell.includes("zsh")) {
      profilePath = path.join(home, ".zshrc");
    } else {
      profilePath = path.join(home, ".bashrc");
    }

    const exportLine = `export ${key}="${value}"`;

    // Check if already present
    if (fs.existsSync(profilePath)) {
      const content = fs.readFileSync(profilePath, "utf8");
      if (content.includes(`export ${key}=`)) {
        // Replace existing line
        const updated = content.replace(
          new RegExp(`^export ${key}=.*$`, "m"),
          exportLine,
        );
        fs.writeFileSync(profilePath, updated);
        console.log(
          chalk.green(`  ✓ Updated ${key} in ${profilePath}`),
        );
        console.log(
          chalk.gray(`    Run: source ${profilePath}  (or open a new terminal)\n`),
        );
        return;
      }
    }

    // Append to profile
    fs.appendFileSync(profilePath, `\n${exportLine}\n`);
    console.log(
      chalk.green(`  ✓ Added ${key} to ${profilePath}`),
    );
    console.log(
      chalk.gray(`    Run: source ${profilePath}  (or open a new terminal)\n`),
    );
  }

  /**
   * Ask a yes/no question
   */
  async askYesNo(question) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      rl.question(question, (answer) => {
        rl.close();
        const normalized = answer.toLowerCase().trim();
        resolve(
          normalized === "" || normalized === "y" || normalized === "yes",
        );
      });
    });
  }

  /**
   * Print next steps
   */
  printNextSteps() {
    console.log(chalk.cyan("Next steps:\n"));
    console.log("  1. Run your tests:");
    console.log(chalk.gray("     vitest run\n"));
    console.log("  2. Use AI agents to write tests:");
    console.log(chalk.gray("     Open VSCode/Cursor and use @testdriver agent\n"));
    console.log("  3. MCP server configured:");
    console.log(chalk.gray("     TestDriver tools are now available in your selected AI client(s)\n"));
    console.log(
      "  4. For CI/CD, add TD_API_KEY to your GitHub repository secrets",
    );
    console.log(
      chalk.gray("     Settings → Secrets → Actions → New repository secret\n"),
    );
    console.log(
      chalk.cyan(
        "Learn more at https://docs.testdriver.ai/v7/getting-started/\n",
      ),
    );
  }
}

// Get command definition from interface.js
const tempAgent = { workingDir: process.cwd() };
const definitions = createCommandDefinitions(tempAgent);
const commandDef = definitions["init"];

InitCommand.description = commandDef?.description || "";
InitCommand.args = commandDef?.args || {};
InitCommand.flags = commandDef?.flags || {};

module.exports = InitCommand;
