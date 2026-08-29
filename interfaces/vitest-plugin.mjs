import { execSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import { createRequire } from "module";
import os from "os";
import path from "path";
import { postOrUpdateTestResults } from "../lib/github-comment.mjs";
import { setTestRunInfo } from "./shared-test-state.mjs";

// Use createRequire to import CommonJS modules without esbuild processing
const require = createRequire(import.meta.url);
const channelConfig = require("../lib/resolve-channel.js");
const environments = require("../lib/environments.json");

// Import Sentry for error reporting
const Sentry = require("@sentry/node");
const chalk = require("chalk");

// Track if Sentry has been initialized
let sentryInitialized = false;

/**
 * Initialize Sentry for test failure reporting
 * Uses same configuration as lib/sentry.js for consistency
 */
function initializeSentry() {
  if (sentryInitialized) return;

  // Respect telemetry opt-out
  if (process.env.TD_TELEMETRY === "false") {
    return;
  }

  try {
    const version = resolveTestDriverVersion() || "unknown";

    Sentry.init({
      dsn:
        process.env.SENTRY_DSN ||
        "https://452bd5a00dbd83a38ee8813e11c57694@o4510262629236736.ingest.us.sentry.io/4510480443637760",
      environment: channelConfig.sentryEnvironment,
      release: version,
      sampleRate: 0.01,
      tracesSampleRate: 0.01,
      enableLogs: true,
      integrations: [Sentry.httpIntegration(), Sentry.nodeContextIntegration()],
      initialScope: {
        tags: {
          platform: os.platform(),
          arch: os.arch(),
          nodeVersion: process.version,
          runner: "vitest",
        },
      },
      // Filter out events that should not be reported to Sentry
      beforeSend(event, hint) {
        const error = hint.originalException;

        // Don't send user-cancelled errors
        if (error && error.message && error.message.includes("User cancelled")) {
          return null;
        }

        // Don't send test failures - these are expected behavior, not bugs in the SDK
        // Test failures indicate the test found a problem, which is the intended use case
        if (event.exception?.values) {
          for (const exception of event.exception.values) {
            // Filter out TestFailure type (from Vitest test failures)
            if (exception.type === "TestFailure") {
              return null;
            }

            // Filter out common user code errors (ReferenceError, TypeError from user tests)
            // Only report if the error originates from TestDriver SDK code, not user test code
            const isUserCodeError = exception.stacktrace?.frames?.some(frame => {
              const filename = frame.filename || frame.abs_path || "";
              // Check if error is from user test files (not from SDK internals)
              return filename.includes("/tests/") ||
                filename.includes("/test/") ||
                filename.includes(".test.") ||
                filename.includes(".spec.");
            });

            if (isUserCodeError && (exception.type === "ReferenceError" || exception.type === "TypeError")) {
              return null;
            }

            // Filter out ElementNotFoundError - expected test outcome, not a crash
            if (exception.type === "ElementNotFoundError") {
              return null;
            }
          }
        }

        return event;
      },
    });

    sentryInitialized = true;
    logger.debug("Sentry initialized for vitest");
  } catch (err) {
    // Sentry init failed - continue without it
    logger.debug("Failed to initialize Sentry:", err.message);
  }
}

/**
 * Flush Sentry events before process exit
 * @param {number} [timeout=2000] - Timeout in ms
 */
async function flushSentry(timeout = 2000) {
  if (!sentryInitialized) return;
  try {
    await Sentry.flush(timeout);
  } catch (err) {
    // Ignore flush errors
  }
}

/**
 * Resolve the TestDriver SDK version using multiple strategies.
 * Similar to resolveVitestVersion(), guards against import.meta.url rewriting.
 * @returns {string|null}
 */
function resolveTestDriverVersion() {
  try {
    return require("../package.json").version;
  } catch { }

  try {
    const cwdRequire = createRequire(path.join(process.cwd(), "package.json"));
    return cwdRequire("testdriverai/package.json").version;
  } catch { }

  try {
    const pkgPath = path.join(process.cwd(), "node_modules", "testdriverai", "package.json");
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
  } catch { }

  return null;
}

/**
 * Minimum required Vitest major version
 */
const MINIMUM_VITEST_VERSION = 4;

/**
 * Try to read vitest's package.json version using multiple resolution strategies.
 * Vitest's Vite-based transform pipeline can rewrite import.meta.url, causing
 * createRequire to resolve from the wrong location. We fall back to resolving
 * from process.cwd() and then to reading directly from node_modules.
 * @returns {string|null} The vitest version string, or null if not found
 */
function resolveVitestVersion() {
  // Strategy 1: createRequire from import.meta.url (standard CJS interop)
  try {
    return require("vitest/package.json").version;
  } catch { }

  // Strategy 2: createRequire from process.cwd() (works when import.meta.url is rewritten)
  try {
    const cwdRequire = createRequire(path.join(process.cwd(), "package.json"));
    return cwdRequire("vitest/package.json").version;
  } catch { }

  // Strategy 3: read directly from node_modules on disk
  try {
    const vitestPkgPath = path.join(process.cwd(), "node_modules", "vitest", "package.json");
    return JSON.parse(fs.readFileSync(vitestPkgPath, "utf8")).version;
  } catch { }

  return null;
}

/**
 * Check that Vitest version meets minimum requirements
 * @throws {Error} if Vitest version is below minimum or not installed
 */
function checkVitestVersion() {
  const version = resolveVitestVersion();

  if (!version) {
    throw new Error(
      "TestDriver requires Vitest to be installed. " +
      "Please install it: npm install vitest@latest",
    );
  }

  const major = parseInt(version.split(".")[0], 10);
  if (major < MINIMUM_VITEST_VERSION) {
    throw new Error(
      `TestDriver requires Vitest >= ${MINIMUM_VITEST_VERSION}.0.0, but found ${version}. ` +
      `Please upgrade Vitest: npm install vitest@latest`,
    );
  }
}

// Check Vitest version at plugin load time
checkVitestVersion();

/**
 * Simple logger for the vitest plugin
 * Supports log levels: debug, info, warn, error
 * Control via TD_LOG_LEVEL environment variable (default: "info")
 * Set TD_LOG_LEVEL=debug for verbose output
 */
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLogLevel =
  LOG_LEVELS[process.env.TD_LOG_LEVEL?.toLowerCase()] ?? LOG_LEVELS.info;

const logger = {
  debug: (...args) => {
    if (currentLogLevel <= LOG_LEVELS.debug) {
      console.log("[TestDriver]", ...args);
    }
  },
  info: (...args) => {
    if (currentLogLevel <= LOG_LEVELS.info) {
      console.log("[TestDriver]", ...args);
    }
  },
  warn: (...args) => {
    if (currentLogLevel <= LOG_LEVELS.warn) {
      console.warn("[TestDriver]", ...args);
    }
  },
  error: (...args) => {
    if (currentLogLevel <= LOG_LEVELS.error) {
      console.error("[TestDriver]", ...args);
    }
  },
};

/**
 * Timeout wrapper for promises
 * @param {Promise} promise - Promise to wrap
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} operationName - Name of operation for error message
 * @returns {Promise} Promise that rejects if timeout is reached
 */
function withTimeout(promise, timeoutMs, operationName) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(new Error(`${operationName} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    ),
  ]);
}

/**
 * Vitest Plugin for TestDriver
 *
 * Records test runs, test cases, and associates them with dashcam recordings.
 * Uses plugin architecture for better global state management.
 *
 * ## How it works:
 *
 * 1. **Plugin State**: All state is managed in a single `pluginState` object
 *    - No class instances or complex scoping
 *    - Easy to access from anywhere in the plugin
 *    - Dashcam URLs tracked in memory (no temp files!)
 *
 * 2. **Dashcam URL Registration**: Tests register dashcam URLs via simple API
 *    - `globalThis.__testdriverPlugin.registerDashcamUrl(testId, url, platform)`
 *    - No file system operations
 *    - No complex matching logic
 *    - Direct association via test ID
 *
 * 3. **Test Recording Flow**:
 *    - `onTestRunStart`: Create test run record
 *    - `onTestCaseReady`: Track test start time
 *    - `onTestCaseResult`: Record individual test result (immediate)
 *    - `onTestRunEnd`: Complete test run with final stats
 *
 * 4. **Platform Detection**: Automatically detects platform from SDK client
 *    - No manual configuration needed
 *    - Stored when dashcam URL is registered
 */

// Shared state that can be imported by both the reporter and setup files
export const pluginState = {
  testRun: null,
  testRunId: null,
  testRunCompleted: false,
  client: null,
  startTime: null,
  testCases: new Map(),
  recordedTestCases: [], // Store recorded test case data for GitHub comment
  token: null,
  detectedPlatform: null,
  pendingTestCaseRecords: new Set(),
  ciProvider: null,
  gitInfo: {},
  apiKey: null,
  apiRoot: null,
  // TestDriver options to pass to all instances
  testDriverOptions: {},
  // Dashcam URL tracking (in-memory, no files needed!)
  dashcamUrls: new Map(), // testId -> [{url, platform, attempt}]
  lastDashcamUrl: null, // Fallback for when test ID isn't available
  // Suite-level test run tracking
  suiteTestRuns: new Map(), // suiteId -> { runId, testRunDbId, token }
};

// Export functions that can be used by the reporter or tests
export function registerDashcamUrl(testId, url, platform, attempt) {
  logger.debug(`Registering dashcam URL for test ${testId} (attempt ${attempt || 1}):`, url);
  // Support multiple attempts per test - store as array
  if (!pluginState.dashcamUrls.has(testId)) {
    pluginState.dashcamUrls.set(testId, []);
  }
  pluginState.dashcamUrls.get(testId).push({ url, platform, attempt: attempt || 1 });
  pluginState.lastDashcamUrl = url;
}

export function getDashcamUrl(testId) {
  const entries = pluginState.dashcamUrls.get(testId);
  if (!entries) return undefined;
  // Return the last entry for backward compatibility (single URL callers)
  return entries[entries.length - 1];
}

export function getAllDashcamUrls(testId) {
  return pluginState.dashcamUrls.get(testId) || [];
}

export function clearDashcamUrls() {
  pluginState.dashcamUrls.clear();
  pluginState.lastDashcamUrl = null;
}

export function getSuiteTestRun(suiteId) {
  return pluginState.suiteTestRuns.get(suiteId);
}

export function setSuiteTestRun(suiteId, runData) {
  logger.debug(`Setting test run for suite ${suiteId}:`, runData);
  pluginState.suiteTestRuns.set(suiteId, runData);
}

export function clearSuiteTestRun(suiteId) {
  pluginState.suiteTestRuns.delete(suiteId);
}

export function getPluginState() {
  return pluginState;
}

// Export API helper functions for direct use from tests
export async function authenticateWithApiKey(apiKey, apiRoot) {
  if (!apiKey) {
    const error = new Error(
      "TD_API_KEY is not configured. Get your API key at https://console.testdriver.ai/team",
    );
    error.code = "MISSING_API_KEY";
    error.isAuthError = true;
    throw error;
  }

  const url = `${apiRoot}/auth/exchange-api-key`;
  let response;

  try {
    response = await withTimeout(
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ apiKey }),
      }),
      15000,
      "Authentication",
    );
  } catch (fetchError) {
    // Network-level error (fetch failed entirely)
    const networkError = new Error(
      `Unable to reach TestDriver API at ${apiRoot}. ` +
      "Check your internet connection and try again.",
    );
    networkError.code = "NETWORK_ERROR";
    networkError.isNetworkError = true;
    networkError.originalError = fetchError;
    throw networkError;
  }

  if (!response.ok) {
    let data = {};
    try {
      data = await response.json();
    } catch {
      // Response wasn't JSON, use empty object
    }

    // Invalid API key (401)
    if (response.status === 401) {
      const authError = new Error(
        data.message ||
        "Invalid API key. Please check your TD_API_KEY and try again. " +
        "Get your API key at https://console.testdriver.ai/team",
      );
      authError.code = data.error || "INVALID_API_KEY";
      authError.isAuthError = true;
      throw authError;
    }

    // Server errors (5xx) - API is down or having issues
    if (response.status >= 500) {
      const serverError = new Error(
        data.message ||
        `An error occurred on the TestDriver server (HTTP ${response.status}). Please try again later.`,
      );
      serverError.code = data.error || "SERVER_ERROR";
      serverError.isServerError = true;
      throw serverError;
    }

    // Rate limiting (429)
    if (response.status === 429) {
      const rateLimitError = new Error(
        "Too many requests to TestDriver API. Please wait a moment and try again.",
      );
      rateLimitError.code = "RATE_LIMITED";
      rateLimitError.isRateLimitError = true;
      throw rateLimitError;
    }

    // Other HTTP errors
    throw new Error(
      `Authentication failed: ${response.status} ${response.statusText}` +
      (data.message ? ` - ${data.message}` : ""),
    );
  }

  const data = await response.json();
  return data.token;
}

export async function createTestRunDirect(token, apiRoot, testRunData) {
  const url = `${apiRoot}/api/v1/testdriver/test-run-create`;
  const response = await withTimeout(
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(testRunData),
    }),
    10000,
    "Create Test Run",
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `API error: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  return await response.json();
}

export async function recordTestCaseDirect(token, apiRoot, testCaseData) {
  const url = `${apiRoot}/api/v1/testdriver/test-case-create`;
  const response = await withTimeout(
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(testCaseData),
    }),
    10000,
    "Record Test Case",
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `API error: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  return await response.json();
}

// Import TestDriverSDK using require to avoid esbuild transformation issues
const TestDriverSDK = require("../sdk.js");

/**
 * Create a TestDriver client for use in beforeAll/beforeEach hooks
 * This is for the shared instance pattern where one driver is used across multiple tests
 *
 * @param {object} options - TestDriver options
 * @param {string} [options.apiKey] - TestDriver API key (defaults to process.env.TD_API_KEY)
 * @param {boolean} [options.headless] - Run sandbox in headless mode
 * @returns {Promise<TestDriver>} Connected TestDriver client instance
 *
 * @example
 * let testdriver;
 * beforeAll(async () => {
 *   testdriver = await createTestDriver({ headless: true });
 *   await testdriver.provision.chrome({ url: 'https://example.com' });
 * });
 */
export async function createTestDriver(options = {}) {
  // Get global plugin options if available
  const pluginOptions =
    globalThis.__testdriverPlugin?.state?.testDriverOptions || {};

  // Merge options: plugin global options < test-specific options
  const mergedOptions = { ...pluginOptions, ...options };

  // Support TD_OS environment variable for specifying target OS (linux, mac, windows)
  // Priority: test options > plugin options > environment variable > default (linux)
  if (!mergedOptions.os && process.env.TD_OS) {
    mergedOptions.os = process.env.TD_OS;
  }

  // Extract TestDriver-specific options
  const apiKey = mergedOptions.apiKey || process.env.TD_API_KEY;

  // Build config for TestDriverSDK constructor
  const config = { ...mergedOptions };
  delete config.apiKey;

  // Use TD_API_ROOT from environment if not provided in config
  if (!config.apiRoot && process.env.TD_API_ROOT) {
    config.apiRoot = process.env.TD_API_ROOT;
  }

  const testdriver = new TestDriverSDK(apiKey, config);

  // Connect to sandbox
  await testdriver.auth();
  await testdriver.connect();

  return testdriver;
}

/**
 * Register a test with a shared TestDriver instance
 * Call this at the start of each test to associate the test context with the driver
 *
 * @param {TestDriver} testdriver - TestDriver client instance from createTestDriver
 * @param {object} context - Vitest test context (from async (context) => {})
 *
 * @example
 * it("step01: verify login", async (context) => {
 *   registerTest(testdriver, context);
 *   const result = await testdriver.assert("login form visible");
 * });
 */
export function registerTest(testdriver, context) {
  if (!testdriver) {
    throw new Error("registerTest() requires a TestDriver instance");
  }
  if (!context || !context.task) {
    throw new Error(
      "registerTest() requires Vitest context. Pass the context parameter from your test function.",
    );
  }

  testdriver.__vitestContext = context.task;
  logger.debug(`Registered test: ${context.task.name}`);
}

/**
 * Clean up a TestDriver client created with createTestDriver
 * Call this in afterAll to properly disconnect and stop recordings
 *
 * @param {TestDriver} testdriver - TestDriver client instance
 *
 * @example
 * afterAll(async () => {
 *   await cleanupTestDriver(testdriver);
 * });
 */
export async function cleanupTestDriver(testdriver) {
  if (!testdriver) {
    return;
  }

  try {
    // Stop dashcam if it was started
    if (testdriver._dashcam && testdriver._dashcam.recording) {
      try {
        const dashcamUrl = await testdriver.dashcam.stop();
        const debugMode =
          process.env.VERBOSE || process.env.TD_DEBUG;
        if (debugMode) {
          console.log("🎥 Dashcam URL:", dashcamUrl);
        }

        // Register dashcam URL in memory for the reporter
        if (dashcamUrl && globalThis.__testdriverPlugin?.registerDashcamUrl) {
          const testId = testdriver.__vitestContext?.id || "unknown";
          const platform = testdriver.os || "linux";
          globalThis.__testdriverPlugin.registerDashcamUrl(
            testId,
            dashcamUrl,
            platform,
          );
        }
      } catch (error) {
        console.error("❌ Failed to stop dashcam:", error.message);
        if (
          error.name === "NotFoundError" ||
          error.responseData?.error === "NotFoundError"
        ) {
          console.log(
            "   ℹ️  Sandbox session already terminated - dashcam stop skipped",
          );
        }
      }
    }

    await testdriver.disconnect();
  } catch (error) {
    console.error("Error disconnecting client:", error);
  }
}

/**
 * Handle process termination and mark test run as cancelled
 */
async function handleProcessExit() {
  logger.debug("handleProcessExit called");
  logger.debug("testRun:", !!pluginState.testRun);
  logger.debug("testRunId:", pluginState.testRunId);
  logger.debug("testRunCompleted:", pluginState.testRunCompleted);

  if (!pluginState.testRun || !pluginState.testRunId) {
    logger.debug("No test run to cancel - skipping cleanup");
    return;
  }

  // Prevent duplicate completion
  if (pluginState.testRunCompleted) {
    logger.debug("Test run already completed - skipping cancellation");
    return;
  }

  logger.debug("Marking test run as cancelled...");

  try {
    const stats = {
      totalTests: pluginState.testCases.size,
      passedTests: 0,
      failedTests: 0,
      skippedTests: 0,
    };

    const completeData = {
      runId: pluginState.testRunId,
      status: "cancelled",
      totalTests: stats.totalTests,
      passedTests: stats.passedTests,
      failedTests: stats.failedTests,
      skippedTests: stats.skippedTests,
      duration: Date.now() - pluginState.startTime,
    };

    // Update platform if detected
    const platform = getPlatform();
    if (platform) {
      completeData.platform = platform;
    }

    logger.debug("Calling completeTestRun with:", JSON.stringify(completeData));
    await completeTestRun(completeData);
    pluginState.testRunCompleted = true;
    logger.info("Test run marked as cancelled");
  } catch (error) {
    logger.error("Failed to mark test run as cancelled:", error.message);
  }
}

// Set up process exit handlers
let exitHandlersRegistered = false;
let isExiting = false;
let isCancelling = false; // Track if we're in the process of cancelling due to SIGINT/SIGTERM

function registerExitHandlers() {
  if (exitHandlersRegistered) return;
  exitHandlersRegistered = true;

  // Handle Ctrl+C - use 'once' and prepend to run before Vitest's handler
  process.prependOnceListener("SIGINT", () => {
    logger.debug("SIGINT received, cleaning up...");
    if (isExiting) {
      logger.debug("Already exiting, skipping duplicate handler");
      return;
    }
    isExiting = true;
    isCancelling = true; // Mark that we're cancelling

    handleProcessExit()
      .then(() => {
        logger.debug("Cleanup completed successfully");
      })
      .catch((err) => {
        logger.error("Error during SIGINT cleanup:", err.message);
      });
    // Note: We don't call process.exit() here because Vitest 4+ patches it
    // and will throw an error. Instead, we let the signal propagate naturally.
  });

  // Handle kill command
  process.prependOnceListener("SIGTERM", () => {
    logger.debug("SIGTERM received, cleaning up...");
    if (isExiting) return;
    isExiting = true;
    isCancelling = true;

    handleProcessExit()
      .then(() => {
        logger.debug("Cleanup completed successfully");
      })
      .catch((err) => {
        logger.error("Error during SIGTERM cleanup:", err.message);
      });
    // Note: We don't call process.exit() here because Vitest 4+ patches it
    // and will throw an error. Instead, we let the signal propagate naturally.
  });
}

/**
 * Create the TestDriver Vitest plugin
 * This sets up global state and provides the registration API
 */
export default function testDriverPlugin(options = {}) {
  // Store options but don't read env vars yet - they may not be loaded
  // Environment variables will be read in onInit after setupFiles run
  pluginState.apiRoot =
    options.apiRoot ||
    process.env.TD_API_ROOT ||
    channelConfig.channels[channelConfig.active];
  pluginState.ciProvider = detectCI();
  pluginState.gitInfo = getGitInfo();

  // Store TestDriver-specific options (excluding plugin-specific ones)
  const { apiKey, apiRoot, ...testDriverOptions } = options;
  pluginState.testDriverOptions = testDriverOptions;

  // Register process exit handlers to handle cancellation
  registerExitHandlers();

  // Note: globalThis setup happens in vitestSetup.mjs for worker processes
  logger.debug("TestDriver plugin initializing...");
  logger.debug("API root:", pluginState.apiRoot);
  logger.debug("API key from options:", !!options.apiKey);
  logger.debug("API key from env (at config time):", !!process.env.TD_API_KEY);
  logger.debug("CI Provider:", pluginState.ciProvider || "none");
  if (Object.keys(testDriverOptions).length > 0) {
    logger.debug("Global TestDriver options:", testDriverOptions);
  }

  // Create reporter instance
  const reporter = new TestDriverReporter(options);

  // Add name property for Vitest
  reporter.name = "testdriver";

  return reporter;
}

/**
 * TestDriver Reporter Class
 * Handles Vitest test lifecycle events
 */
class TestDriverReporter {
  constructor(options = {}) {
    this.options = options;
    logger.debug("Reporter created with options:", {
      hasApiKey: !!options.apiKey,
      hasApiRoot: !!options.apiRoot,
    });
  }

  async onInit(ctx) {
    this.ctx = ctx;
    logger.debug("onInit called - UPDATED VERSION");

    // Initialize Sentry for error reporting
    initializeSentry();

    // NOW read the API key and API root (after setupFiles have run, including dotenv/config)
    pluginState.apiKey = this.options.apiKey || process.env.TD_API_KEY;
    pluginState.apiRoot =
      this.options.apiRoot ||
      process.env.TD_API_ROOT ||
      channelConfig.channels[channelConfig.active];
    logger.debug("API key from options:", !!this.options.apiKey);
    logger.debug("API key from env (at onInit):", !!process.env.TD_API_KEY);
    logger.debug("API root from options:", this.options.apiRoot);
    logger.debug("API root from env (at onInit):", process.env.TD_API_ROOT);
    logger.debug("Final API key set:", !!pluginState.apiKey);
    logger.debug("Final API root set:", pluginState.apiRoot);

    // Initialize test run
    await this.initializeTestRun();
  }

  async initializeTestRun() {
    logger.debug("initializeTestRun called");
    logger.debug("API key present:", !!pluginState.apiKey);
    logger.debug("API root:", pluginState.apiRoot);

    // Environment info is printed by the SDK when each test initializes,
    // so we skip the duplicate banner here in the reporter.

    // Check if we should enable the reporter
    if (!pluginState.apiKey) {
      logger.warn("No API key provided, skipping test recording");
      logger.debug(
        "API key sources - options:",
        !!this.options.apiKey,
        "env:",
        !!process.env.TD_API_KEY,
      );
      return;
    }

    try {
      // Exchange API key for JWT token
      logger.debug("Authenticating with API...");
      await authenticate();
      logger.debug("Authentication successful, token received");

      // Generate unique run ID
      pluginState.testRunId = generateRunId();
      pluginState.startTime = Date.now();
      pluginState.testRunCompleted = false; // Reset completion flag

      // Create test run via direct API call
      const testRunData = {
        runId: pluginState.testRunId,
        suiteName: getSuiteName(this.ctx),
        ...pluginState.gitInfo,
      };

      // Session ID will be added from the first test result file that includes it

      // Only add ciProvider if it's not null
      if (pluginState.ciProvider) {
        testRunData.ciProvider = pluginState.ciProvider;
      }

      // Platform will be set from the first test result file
      // Default to linux if no tests write platform info
      testRunData.platform = "linux";

      // Send version metadata
      testRunData.nodeVersion = process.version;
      const tdVer = resolveTestDriverVersion();
      if (tdVer) {
        testRunData.testDriverVersion = tdVer;
      }
      const vitestVer = resolveVitestVersion();
      if (vitestVer) {
        testRunData.vitestVersion = vitestVer;
      }

      logger.debug("Creating test run with data:", JSON.stringify(testRunData));
      pluginState.testRun = await createTestRun(testRunData);
      logger.debug("Test run created:", JSON.stringify(pluginState.testRun));

      // Store in environment variables for worker processes to access
      process.env.TD_TEST_RUN_ID = pluginState.testRunId;
      process.env.TD_TEST_RUN_DB_ID = pluginState.testRun.data?.id || "";
      process.env.TD_TEST_RUN_TOKEN = pluginState.token;

      // Also store in shared state module (won't work across processes but good for main)
      setTestRunInfo({
        testRun: pluginState.testRun,
        testRunId: pluginState.testRunId,
        token: pluginState.token,
        apiKey: pluginState.apiKey,
        apiRoot: pluginState.apiRoot,
        startTime: pluginState.startTime,
      });
    } catch (error) {
      logger.error("Failed to initialize:", error.message);
      pluginState.apiKey = null;
      pluginState.token = null;
    }
  }

  async onTestRunEnd(testModules, unhandledErrors, reason) {
    logger.debug("onTestRunEnd called with reason:", reason);
    logger.debug("API key present:", !!pluginState.apiKey);
    logger.debug("Test run present:", !!pluginState.testRun);
    logger.debug("Test run ID:", pluginState.testRunId);
    logger.debug("isCancelling:", isCancelling);
    logger.debug("testRunCompleted:", pluginState.testRunCompleted);

    // If we're cancelling due to SIGINT/SIGTERM, skip - handleProcessExit will handle it
    if (isCancelling) {
      logger.debug(
        "Cancellation in progress via signal handler, skipping onTestRunEnd",
      );
      return;
    }

    // If already completed (by handleProcessExit), skip
    if (pluginState.testRunCompleted) {
      logger.debug("Test run already completed, skipping");
      return;
    }

    if (!pluginState.apiKey) {
      logger.warn(
        "Skipping completion - no API key (was it cleared after init failure?)",
      );
      return;
    }

    if (!pluginState.testRun) {
      logger.warn(
        "Skipping completion - no test run created (check initialization logs)",
      );
      return;
    }

    logger.debug("Completing test run...");

    try {
      // Calculate statistics from testModules
      const stats = calculateStatsFromModules(testModules);

      logger.debug("Stats:", stats);

      // Determine overall status based on stats (not reason, which is unreliable in parallel runs)
      let status = "passed";
      if (stats.failedTests > 0) {
        status = "failed";
      } else if (reason === "interrupted") {
        status = "cancelled";
      } else if (stats.totalTests === 0) {
        status = "cancelled";
      } else if (stats.passedTests === 0 && stats.skippedTests === 0) {
        // No tests actually ran (all were filtered/excluded)
        status = "cancelled";
      }

      // Complete test run via API
      logger.debug(
        `Completing test run ${pluginState.testRunId} with status: ${status}`,
      );

      const completeData = {
        runId: pluginState.testRunId,
        status,
        totalTests: stats.totalTests,
        passedTests: stats.passedTests,
        failedTests: stats.failedTests,
        skippedTests: stats.skippedTests,
        duration: Date.now() - pluginState.startTime,
      };

      // Update platform if detected from test results
      const platform = getPlatform();
      logger.debug(
        `Platform detection result: ${platform}, detectedPlatform in state: ${pluginState.detectedPlatform}`,
      );
      if (platform) {
        completeData.platform = platform;
        logger.debug(`Updating test run with platform: ${platform}`);
      } else {
        logger.warn(
          `No platform detected, test run will keep default platform`,
        );
      }

      // Wait for any pending operations (shouldn't be any, but just in case)
      if (pluginState.pendingTestCaseRecords.size > 0) {
        logger.debug(
          `Waiting for ${pluginState.pendingTestCaseRecords.size} pending operations...`,
        );
        await Promise.all(Array.from(pluginState.pendingTestCaseRecords));
      }

      // Test cases are reported directly from teardownTest
      logger.debug("Calling completeTestRun API...");
      logger.debug("Complete data:", JSON.stringify(completeData));

      const completeResponse = await completeTestRun(completeData);
      logger.debug("API response:", JSON.stringify(completeResponse));

      // Mark test run as completed to prevent duplicate completion
      pluginState.testRunCompleted = true;

      // Output the test run URL for CI to capture
      const testRunDbId = process.env.TD_TEST_RUN_DB_ID;
      const consoleUrl = getConsoleUrl(pluginState.apiRoot);
      if (testRunDbId) {
        const testRunUrl = `${consoleUrl}/runs/${testRunDbId}`;
        logger.info(`View test run: ${testRunUrl}`);
        // Output in a parseable format for CI
        console.log(`TESTDRIVER_RUN_URL=${testRunUrl}`);

        // Post GitHub comment if in CI environment
        await postGitHubCommentIfEnabled(testRunUrl, stats, completeData);
      }

      logger.info(
        `Test run completed: ${stats.passedTests}/${stats.totalTests} passed`,
      );
    } catch (error) {
      logger.error("Failed to complete test run:", error.message);
      logger.debug("Error stack:", error.stack);
    } finally {
      // Flush any pending Sentry events before process exits
      await flushSentry();
    }
  }

  onTestCaseReady(test) {
    if (!pluginState.apiKey || !pluginState.testRun) return;

    pluginState.testCases.set(test.id, {
      test,
      startTime: Date.now(),
    });
  }

  async onTestCaseResult(test) {
    if (!pluginState.apiKey || !pluginState.testRun) return;

    const result = test.result();
    const status =
      result.state === "passed"
        ? "passed"
        : result.state === "skipped"
          ? "skipped"
          : "failed";

    logger.debug(`Test case completed: ${test.name} (${status})`);

    // Calculate duration from tracked start time
    const testCase = pluginState.testCases.get(test.id);
    const duration = testCase ? Date.now() - testCase.startTime : 0;

    logger.debug(
      `Calculated duration: ${duration}ms (startTime: ${testCase?.startTime}, now: ${Date.now()})`,
    );

    // Read test metadata from Vitest's task.meta (set in test hooks)
    const meta = test.meta();
    logger.debug(`Test meta for ${test.id}:`, meta);

    const dashcamUrl = meta.dashcamUrl || null;
    const dashcamUrls = meta.dashcamUrls || []; // Per-attempt URLs
    const sessionId = meta.sessionId || null;
    const platform = meta.platform || null;
    const sandboxId = meta.sandboxId || null;

    // Test identity from Vitest's standard reporter API (TestCase in v4+).
    const projectName = test.project?.name || null;
    const projectRoot = test.project?.config?.root || process.cwd();
    const moduleId = test.module?.moduleId || null;
    let testFile =
      moduleId && !moduleId.includes("://") ? path.relative(projectRoot, moduleId) : "unknown";
    if (path.isAbsolute(testFile) || testFile.startsWith("..")) testFile = "unknown";

    // Full nested describe path (top-level first), joined with " > ".
    const suitePath = [];
    {
      let cursor = test.parent;
      while (cursor && cursor.type === "suite") {
        suitePath.unshift(cursor.name);
        cursor = cursor.parent;
      }
    }
    const suiteName = suitePath.length > 0 ? suitePath.join(" > ") : null;

    // Update test run platform from first test that reports it
    if (platform && !pluginState.detectedPlatform) {
      pluginState.detectedPlatform = platform;
    }

    // Get test run info from environment variables
    const testRunId = process.env.TD_TEST_RUN_ID;
    const token = process.env.TD_TEST_RUN_TOKEN;

    if (!testRunId || !token) {
      logger.warn(
        `Test run not initialized, skipping test case recording for: ${test.name}`,
      );
      return;
    }

    try {
      let errorMessage = null;
      let errorStack = null;

      if (
        result.state === "failed" &&
        result.errors &&
        result.errors.length > 0
      ) {
        const error = result.errors[0];
        errorMessage = error.message;
        errorStack = error.stack;

        // Note: We do NOT report test failures to Sentry.
        // Test failures are expected behavior (they indicate a test found a bug).
        // We only want actual SDK crashes and exceptions reported to Sentry.
      }

      const startTime = Date.now() - duration; // Calculate start time from duration
      // In Vitest v4, retryCount is on diagnostic(), not result()
      // result() only returns { state, errors }, while diagnostic() has retryCount, duration, etc.
      const diagnostic = test.diagnostic?.();
      const retryCount = diagnostic?.retryCount || 0;
      const testRunDbId = process.env.TD_TEST_RUN_DB_ID;
      const consoleUrl = getConsoleUrl(pluginState.apiRoot);
      const hasRetries = retryCount > 0 && dashcamUrls.length > 1;

      // Record a single test case with all metadata.
      // Field names match the current API contract; `projectName` is a
      // forward-compatible addition (ignored by the API today).
      const testCaseData = {
        runId: testRunId,
        testName: test.name,
        testFile: testFile,
        projectName: projectName,
        status,
        startTime: startTime,
        endTime: Date.now(),
        duration: duration,
        retries: retryCount,
      };

      // Add sessionId if available
      if (sessionId) {
        testCaseData.sessionId = sessionId;
      }

      // Only include replayUrl if we have a valid dashcam URL
      if (dashcamUrl) {
        testCaseData.replayUrl = dashcamUrl;
      }

      // Include per-attempt replay URLs for retry visibility
      if (dashcamUrls.length > 0) {
        const attemptUrls = dashcamUrls
          .map(a => ({
            attempt: a.attempt,
            url: a.url || null,
            sessionId: a.sessionId || null,
            errorMessage: a.errorMessage || null,
            errorStack: a.errorStack || null,
          }));
        testCaseData.replayUrls = attemptUrls;
      }

      if (suiteName) testCaseData.suiteName = suiteName;
      if (errorMessage) testCaseData.errorMessage = errorMessage;
      if (errorStack) testCaseData.errorStack = errorStack;

      logger.debug(
        `Recording test case: ${test.name} (${status}) with testFile: ${testFile}, project: ${projectName}, suite: ${suiteName || "(none)"}, duration: ${duration}ms, replay: ${dashcamUrl ? "yes" : "no"}`,
      );

      const testCaseResponse = await recordTestCaseDirect(
        token,
        pluginState.apiRoot,
        testCaseData,
      );

      const testCaseDbId = testCaseResponse.data?.id;

      // Store test case data for GitHub comment generation
      pluginState.recordedTestCases.push({
        ...testCaseData,
        id: testCaseDbId,
      });

      console.log("");
      console.log(
        chalk.cyan(`🔗 Test Report: ${consoleUrl}/runs/${testRunDbId}/${testCaseDbId}`),
      );
      console.log("");

      // Write per-test-case JSON result file
      {
        const testResult = meta.testResult || {};

        // Parse replay URL to extract replayId and shareKey for embed links
        let replayUrl = dashcamUrl || null;
        let replayGifUrl = null;
        let replayEmbedUrl = null;
        let replayMarkdown = null;
        const replayMatch = dashcamUrl && dashcamUrl.match(/\/replay\/([a-f0-9]+)\?share=([^&\s]+)/);
        if (replayMatch) {
          const [, replayId, shareKey] = replayMatch;
          const apiRoot = pluginState.apiRoot;
          replayGifUrl = `${apiRoot}/replay/${replayId}/gif?shareKey=${shareKey}`;
          replayEmbedUrl = `${consoleUrl}/replay/${replayId}?share=${shareKey}&embed=true`;
          replayMarkdown = `[![Test Recording](${replayGifUrl})](${replayUrl})`;
        }

        const resultData = {
          // Versions
          versions: {
            sdk: testResult.sdkVersion || null,
            vitest: resolveVitestVersion() || null,
            api: testResult.apiVersion || null,
            runnerBefore: testResult.runnerVersionBefore || null,
            runnerAfter: testResult.runnerVersionAfter || null,
            runnerWasUpdated: testResult.wasUpdated || false,
          },

          // Test info
          test: {
            file: testResult.testFile || null,
            name: testResult.testName || null,
            suite: testResult.suiteName || null,
            passed: status === "passed",
            caseId: testCaseDbId || null,
            runId: testRunDbId || null,
            error: errorMessage || testResult.error || null,
            errorStack: errorStack || testResult.errorStack || null,
          },

          // URLs
          urls: {
            api: testResult.apiUrl || null,
            console: consoleUrl || null,
            vnc: testResult.vncUrl || null,
            testRun: testCaseDbId ? `${consoleUrl}/runs/${testRunDbId}/${testCaseDbId}` : null,
          },

          // Recording replay
          replay: {
            url: replayUrl,
            gifUrl: replayGifUrl,
            embedUrl: replayEmbedUrl,
            markdown: replayMarkdown,
          },

          // Timing
          date: testResult.date || new Date().toISOString(),

          // Team & session
          team: {
            id: testResult.teamId || null,
            sessionId: testResult.sessionId || null,
          },

          // Infrastructure
          infrastructure: {
            sandboxId: testResult.sandboxId || null,
            instanceId: testResult.instanceId || null,
            os: testResult.os || null,
            amiId: testResult.amiId || null,
            e2bTemplateId: testResult.e2bTemplateId || null,
            imageVersion: testResult.imageVersion || null,
          },

          // Realtime
          realtime: {
            channel: testResult.realtimeChannel || null,
            messageCount: testResult.realtimeMessageCount || 0,
          },

          // Interactions
          interactions: testResult.interactions || { total: 0, cached: 0, byType: {} },
        };

        // Use Vitest's stable per-test id as the filename — it's unique within
        // a run and avoids the name-collision problem entirely.
        const resultDir = path.join(process.cwd(), ".testdriver", "results", testFile);
        fs.mkdirSync(resultDir, { recursive: true });
        const safeId = (test.id || "unknown").replace(/[^\w.-]/g, "_");
        fs.writeFileSync(
          path.join(resultDir, `${safeId}.json`),
          JSON.stringify(resultData, null, 2),
        );
      }

      // If there were retries, list all per-attempt dashcam URLs for debugging
      if (hasRetries) {
        const validAttempts = dashcamUrls.filter(a => a.url);
        if (validAttempts.length > 0) {
          console.log(`📋 Retry attempts (${dashcamUrls.length} total):`);
          for (const attempt of validAttempts) {
            console.log(`   Attempt ${attempt.attempt}: ${attempt.url}`);
          }
        }
      }

    } catch (error) {
      logger.error("Failed to report test case:", error.message);
    }
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Maps an API root URL to its corresponding web console URL.
 * The API and web console are served from different domains/ports.
 *
 * @param {string} apiRoot - The API root URL (e.g., https://api.testdriver.ai)
 * @returns {string} The corresponding web console URL
 */
function getConsoleUrl(apiRoot) {
  // Explicit override — use TD_CONSOLE_URL when deliberately set
  if (process.env.TD_CONSOLE_URL) return process.env.TD_CONSOLE_URL;

  if (!apiRoot) return "https://console.testdriver.ai";

  // Fly.io: swap "-api" for "-web" in the hostname
  // e.g. preview-138-api.fly.dev -> preview-138-web.fly.dev
  //      td-test-api.fly.dev     -> td-test-web.fly.dev
  const flyMatch = apiRoot.match(/https:\/\/([\w-]+)-api\.fly\.dev/);
  if (flyMatch) {
    return `https://${flyMatch[1]}-web.fly.dev`;
  }

  // Known channel API URLs -> console equivalents (from environments.json)
  // e.g. https://api-dev.testdriver.ai -> https://console-dev.testdriver.ai
  for (const env of Object.values(environments)) {
    if (env.apiRoot === apiRoot && env.consoleUrl) {
      return env.consoleUrl;
    }
  }

  // Local development
  if (apiRoot.includes("ngrok.io") || apiRoot.includes("trycloudflare.com") || apiRoot.includes("localhost")) {
    return "http://localhost:3001";
  }

  // Render PR previews (legacy)
  const renderPrMatch = apiRoot.match(/https:\/\/([\w-]+)-api(-[\w]+)?(-pr-\d+)?\.onrender\.com/);
  if (renderPrMatch) {
    const [, prefix, suffix, prSuffix] = renderPrMatch;
    const webPrefix = (prefix === 'testdriver' && suffix) ? 'web' + suffix : prefix + '-web';
    return `https://${webPrefix}${prSuffix || ''}.onrender.com`;
  }

  return apiRoot;
}

function generateRunId() {
  return `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function getSuiteName(ctx) {
  // Derived from Vitest's configured projects (joined when multiple).
  // Must always return a string: the test-run-create API requires suiteName.
  const projects = ctx?.projects;
  if (Array.isArray(projects) && projects.length > 0) {
    const names = projects.map((p) => p?.name).filter(Boolean);
    if (names.length > 0) return names.join(",");
  }
  return process.env.npm_package_name || path.basename(process.cwd());
}

function getPlatform() {
  // First try to get platform from SDK client detected during test execution
  if (pluginState.detectedPlatform) {
    logger.debug(
      `Using platform from SDK client: ${pluginState.detectedPlatform}`,
    );
    return pluginState.detectedPlatform;
  }

  // Try to get platform from dashcam URLs (registered during test cleanup)
  for (const [, entries] of pluginState.dashcamUrls) {
    // entries is now an array of {url, platform, attempt}
    const arr = Array.isArray(entries) ? entries : [entries];
    for (const data of arr) {
      if (data.platform) {
        logger.debug(
          `Using platform from dashcam URL registration: ${data.platform}`,
        );
        return data.platform;
      }
    }
  }

  logger.debug("Platform not yet detected from client");
  return null;
}

function calculateStatsFromModules(testModules) {
  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;
  let skippedTests = 0;

  // Guard against corrupt or circular test tree structures
  // (can happen with --sequence.concurrent in some Vitest versions)
  const seen = new Set();

  for (const testModule of testModules) {
    try {
      for (const testCase of testModule.children.allTests()) {
        // Deduplicate - skip if we've already counted this test
        if (seen.has(testCase.id)) continue;
        seen.add(testCase.id);

        const result = testCase.result();
        if (result.state === "passed") {
          passedTests++;
          totalTests++;
        } else if (result.state === "failed") {
          failedTests++;
          totalTests++;
        } else if (result.state === "skipped") {
          skippedTests++;
        }
      }
    } catch (err) {
      logger.warn(`Error calculating stats for module: ${err.message}`);
    }
  }

  return { totalTests, passedTests, failedTests, skippedTests };
}

function detectCI() {
  if (process.env.GITHUB_ACTIONS) return "github";
  if (process.env.GITLAB_CI) return "gitlab";
  if (process.env.CIRCLECI) return "circle";
  if (process.env.TRAVIS) return "travis";
  if (process.env.JENKINS_URL) return "jenkins";
  if (process.env.BUILDKITE) return "buildkite";
  return null;
}

function getGitInfo() {
  const info = {};

  if (process.env.GITHUB_ACTIONS) {
    if (process.env.GITHUB_REPOSITORY)
      info.repo = process.env.GITHUB_REPOSITORY;
    if (process.env.GITHUB_REF_NAME) info.branch = process.env.GITHUB_REF_NAME;
    if (process.env.GITHUB_SHA) info.commit = process.env.GITHUB_SHA;
    if (process.env.GITHUB_ACTOR) info.author = process.env.GITHUB_ACTOR;

    // The GitHub account the run is attributed to. Sent separately from
    // `author` — which is the same value here but means "git display name"
    // outside GitHub CI — so the API has one unambiguous field to bill per
    // GitHub user on. The API still falls back to `author` for SDKs older
    // than this, so don't assume this field is always present server-side.
    if (process.env.GITHUB_ACTOR) info.githubActor = process.env.GITHUB_ACTOR;
    if (process.env.GITHUB_RUN_ID) info.githubRunId = process.env.GITHUB_RUN_ID;
    if (process.env.GITHUB_RUN_ATTEMPT) {
      info.githubRunAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
    }
    // Exported to $GITHUB_ENV by the testdriver action after it verifies the
    // OIDC token (see `action/action.yml`). GitHub itself provides no
    // GITHUB_ACTOR_ID env var, so this is absent whenever the caller
    // authenticated with a bare TD_API_KEY secret instead of our action.
    if (process.env.TD_GITHUB_ACTOR_ID) {
      info.githubActorId = process.env.TD_GITHUB_ACTOR_ID;
    }
  } else if (process.env.GITLAB_CI) {
    if (process.env.CI_PROJECT_PATH) info.repo = process.env.CI_PROJECT_PATH;
    if (process.env.CI_COMMIT_BRANCH)
      info.branch = process.env.CI_COMMIT_BRANCH;
    if (process.env.CI_COMMIT_SHA) info.commit = process.env.CI_COMMIT_SHA;
    if (process.env.GITLAB_USER_LOGIN)
      info.author = process.env.GITLAB_USER_LOGIN;
  } else if (process.env.CIRCLECI) {
    if (
      process.env.CIRCLE_PROJECT_USERNAME &&
      process.env.CIRCLE_PROJECT_REPONAME
    ) {
      info.repo = `${process.env.CIRCLE_PROJECT_USERNAME}/${process.env.CIRCLE_PROJECT_REPONAME}`;
    }
    if (process.env.CIRCLE_BRANCH) info.branch = process.env.CIRCLE_BRANCH;
    if (process.env.CIRCLE_SHA1) info.commit = process.env.CIRCLE_SHA1;
    if (process.env.CIRCLE_USERNAME) info.author = process.env.CIRCLE_USERNAME;
  }

  // If not in CI or if commit info is missing, try to get it from local git
  if (!info.commit) {
    try {
      info.commit = execSync("git rev-parse HEAD", {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      logger.debug("Git commit from local:", info.commit);
    } catch (e) {
      logger.debug("Failed to get git commit:", e.message);
    }
  }

  if (!info.branch) {
    try {
      info.branch = execSync("git rev-parse --abbrev-ref HEAD", {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      logger.debug("Git branch from local:", info.branch);
    } catch (e) {
      logger.debug("Failed to get git branch:", e.message);
    }
  }

  if (!info.author) {
    try {
      info.author = execSync("git config user.name", {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      logger.debug("Git author from local:", info.author);
    } catch (e) {
      logger.debug("Failed to get git author:", e.message);
    }
  }

  if (!info.repo) {
    try {
      const remoteUrl = execSync("git config --get remote.origin.url", {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();

      // Extract repo from git URL (supports both SSH and HTTPS)
      // SSH: git@github.com:user/repo.git
      // HTTPS: https://github.com/user/repo.git
      const match = remoteUrl.match(/[:/]([^/:]+\/[^/:]+?)(\.git)?$/);
      if (match) {
        info.repo = match[1];
        logger.debug("Git repo from local:", info.repo);
      }
    } catch (e) {
      logger.debug("Failed to get git repo:", e.message);
    }
  }

  logger.debug("Collected git info:", info);
  return info;
}

// ============================================================================
// GitHub Comment Helper
// ============================================================================

/**
 * Extract PR number from GitHub Actions environment
 * Checks multiple sources: env vars, event file, and GITHUB_REF
 * @returns {string|null} PR number or null if not found
 */
function extractPRNumber() {
  // Try direct environment variables first
  let prNumber =
    process.env.GITHUB_PR_NUMBER ||
    process.env.TD_GITHUB_PR ||
    process.env.PR_NUMBER;

  if (prNumber) {
    return prNumber;
  }

  // Try to extract from GitHub Actions event path
  if (process.env.GITHUB_EVENT_PATH) {
    try {
      const eventData = JSON.parse(
        fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"),
      );
      if (eventData.pull_request?.number) {
        return String(eventData.pull_request.number);
      }
    } catch (err) {
      logger.debug("Could not read GitHub event file:", err.message);
    }
  }

  // Try to extract from GITHUB_REF (refs/pull/123/merge or refs/pull/123/head)
  if (process.env.GITHUB_REF) {
    const match = process.env.GITHUB_REF.match(
      /refs\/pull\/(\d+)\/(merge|head)/,
    );
    if (match) {
      return match[1];
    }
  }

  return null;
}

/**
 * Post GitHub comment with test results if enabled
 * Checks for GitHub token and PR number in environment variables
 * @param {string} testRunUrl - URL to the test run
 * @param {Object} stats - Test statistics
 * @param {Object} completeData - Test run completion data
 */
async function postGitHubCommentIfEnabled(testRunUrl, stats, completeData) {
  try {
    // Check if GitHub comments are explicitly disabled
    if (process.env.TESTDRIVER_SKIP_GITHUB_COMMENT === "true") {
      logger.debug(
        "GitHub comments disabled via TESTDRIVER_SKIP_GITHUB_COMMENT",
      );
      return;
    }

    // Check if GitHub comment posting is enabled
    const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const prNumber = extractPRNumber();
    const commitSha = process.env.GITHUB_SHA || pluginState.gitInfo.commit;

    // Only post if we have a token and either a PR number or commit SHA
    if (!githubToken) {
      logger.debug("GitHub token not found, skipping comment posting");
      return;
    }

    if (!prNumber && !commitSha) {
      logger.debug(
        "Neither PR number nor commit SHA found, skipping comment posting",
      );
      return;
    }

    // Extract owner/repo from git info
    const repo = pluginState.gitInfo.repo;
    if (!repo) {
      logger.warn("Repository info not available, skipping GitHub comment");
      return;
    }

    const [owner, repoName] = repo.split("/");
    if (!owner || !repoName) {
      logger.warn("Invalid repository format, expected owner/repo");
      return;
    }

    logger.debug("Preparing GitHub comment...");

    // Prepare test run data for comment
    const testRunData = {
      runId: pluginState.testRunId,
      status: completeData.status,
      totalTests: stats.totalTests,
      passedTests: stats.passedTests,
      failedTests: stats.failedTests,
      skippedTests: stats.skippedTests,
      duration: completeData.duration,
      testRunUrl,
      platform:
        completeData.platform || pluginState.detectedPlatform || "unknown",
      branch: pluginState.gitInfo.branch || "unknown",
      commit: commitSha || "unknown",
    };

    // Use recorded test cases from pluginState
    const testCases = pluginState.recordedTestCases || [];

    logger.info(
      `Posting GitHub comment with ${testCases.length} test cases...`,
    );

    // Post or update GitHub comment
    const githubOptions = {
      token: githubToken,
      owner,
      repo: repoName,
      prNumber: prNumber ? parseInt(prNumber, 10) : undefined,
      commitSha: commitSha,
    };

    const comment = await postOrUpdateTestResults(
      testRunData,
      testCases,
      githubOptions,
    );
    logger.info(`✅ GitHub comment posted: ${comment.html_url}`);
    console.log(`\n🔗 GitHub Comment: ${comment.html_url}\n`);
  } catch (error) {
    logger.warn("Failed to post GitHub comment:", error.message);
    logger.debug("GitHub comment error stack:", error.stack);
  }
}

// ============================================================================
// API Methods
// ============================================================================

async function authenticate() {
  const url = `${pluginState.apiRoot}/auth/exchange-api-key`;
  const response = await withTimeout(
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        apiKey: pluginState.apiKey,
      }),
    }),
    10000,
    "Internal Authentication",
  );

  if (!response.ok) {
    throw new Error(
      `Authentication failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = await response.json();
  pluginState.token = data.token;
}

async function createTestRun(data) {
  const url = `${pluginState.apiRoot}/api/v1/testdriver/test-run-create`;
  const response = await withTimeout(
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pluginState.token}`,
      },
      body: JSON.stringify(data),
    }),
    10000,
    "Internal Create Test Run",
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `API error: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  return await response.json();
}

async function completeTestRun(data) {
  const url = `${pluginState.apiRoot}/api/v1/testdriver/test-run-complete`;
  logger.debug(`completeTestRun: POSTing to ${url}`);

  try {
    const response = await withTimeout(
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${pluginState.token}`,
        },
        body: JSON.stringify(data),
      }),
      10000,
      "Internal Complete Test Run",
    );

    logger.debug(`completeTestRun: Response status ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `API error: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const result = await response.json();
    logger.debug(`completeTestRun: Success`);
    return result;
  } catch (error) {
    logger.error(`completeTestRun: Error - ${error.message}`);
    throw error;
  }
}

// Global state setup moved to setup file (vitestSetup.mjs)
// The setup file imports the exported functions and makes them available globally in worker processes
