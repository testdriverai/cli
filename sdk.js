const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { formatter } = require("./sdk-log-formatter");
const { createProvisionAPI } = require("./lib/provision");

// Load .env — use monorepo root .env when running inside the monorepo,
// otherwise fall back to default dotenv.config() for end users.
const _isMonorepo = __dirname.includes(require('path').join('mono', 'sdk'));
if (_isMonorepo) {
  require('../shared/load-env');
} else {
  require('dotenv').config();
}

/**
 * Get the file path of the caller (the file that called TestDriver)
 * @returns {string|null} File path or null if not found
 */
function getCallerFilePath() {
  const originalPrepareStackTrace = Error.prepareStackTrace;
  try {
    const err = new Error();
    Error.prepareStackTrace = (_, stack) => stack;
    const stack = err.stack;
    Error.prepareStackTrace = originalPrepareStackTrace;

    // Look for the first file that's not sdk.js, hooks.mjs, or node internals
    for (const callSite of stack) {
      const fileName = callSite.getFileName();
      if (
        fileName &&
        !fileName.includes("sdk.js") &&
        !fileName.includes("hooks.mjs") &&
        !fileName.includes("hooks.js") &&
        !fileName.includes("node_modules") &&
        !fileName.includes("node:internal") &&
        fileName !== "evalmachine.<anonymous>"
      ) {
        return fileName;
      }
    }
  } catch (error) {
    // Silently fail and return null
  } finally {
    Error.prepareStackTrace = originalPrepareStackTrace;
  }
  return null;
}

/**
 * Generate a hash of the caller file for use as a cache key
 * @returns {string|null} Hash of the file or null if file not found
 */
function getCallerFileHash() {
  const filePath = getCallerFilePath();
  if (!filePath) {
    return null;
  }

  try {
    // Handle file:// URLs by converting to file system path
    let fsPath = filePath;
    if (filePath.startsWith("file://")) {
      fsPath = filePath.replace("file://", "");
    }

    const fileContent = fs.readFileSync(fsPath, "utf-8");
    const hash = crypto.createHash("sha256").update(fileContent).digest("hex");
    // Return first 16 chars of hash for brevity
    return hash.substring(0, 16);
  } catch (error) {
    // If we can't read the file, return null
    return null;
  }
}

/**
 * Get detailed caller information including file path, line number, and column
 * Used for automatic screenshot naming to identify which line of code triggered an action
 * @param {number} [skipFrames=0] - Additional frames to skip in the stack trace
 * @returns {{filePath: string|null, line: number|null, column: number|null, functionName: string|null}}
 */
function getCallerInfo(skipFrames = 0) {
  const originalPrepareStackTrace = Error.prepareStackTrace;
  try {
    const err = new Error();
    Error.prepareStackTrace = (_, stack) => stack;
    const stack = err.stack;
    Error.prepareStackTrace = originalPrepareStackTrace;

    // Look for the first file that's not sdk.js, hooks.mjs, or node internals
    let skipped = 0;
    for (const callSite of stack) {
      const fileName = callSite.getFileName();
      if (
        fileName &&
        !fileName.includes("sdk.js") &&
        !fileName.includes("hooks.mjs") &&
        !fileName.includes("hooks.js") &&
        !fileName.includes("node_modules") &&
        !fileName.includes("node:internal") &&
        fileName !== "evalmachine.<anonymous>"
      ) {
        if (skipped < skipFrames) {
          skipped++;
          continue;
        }
        return {
          filePath: fileName,
          line: callSite.getLineNumber(),
          column: callSite.getColumnNumber(),
          functionName: callSite.getFunctionName(),
        };
      }
    }
  } catch (error) {
    // Silently fail and return nulls
  } finally {
    Error.prepareStackTrace = originalPrepareStackTrace;
  }
  return { filePath: null, line: null, column: null, functionName: null };
}

/**
 * Custom error class for element operation failures
 * Includes debugging information like screenshots and AI responses
 */
class ElementNotFoundError extends Error {
  constructor(message, debugInfo = {}) {
    super(message);
    this.name = "ElementNotFoundError";
    // Sanitize aiResponse to remove base64 images before storing
    this.aiResponse = this._sanitizeAiResponse(debugInfo.aiResponse);
    this.description = debugInfo.description;
    this.timestamp = new Date().toISOString();
    this.screenshotPath = null;

    // Capture stack trace but skip internal frames
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ElementNotFoundError);
    }

    // Write screenshot to temp directory immediately (don't store on error object)
    // This prevents vitest from serializing huge base64 strings
    if (debugInfo.screenshot) {
      try {
        const tempDir = path.join(os.tmpdir(), "testdriver-debug");
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }

        const filename = `screenshot-${Date.now()}.png`;
        this.screenshotPath = path.join(tempDir, filename);

        // Remove data:image/png;base64, prefix if present
        const base64Data = debugInfo.screenshot.replace(
          /^data:image\/\w+;base64,/,
          "",
        );
        const buffer = Buffer.from(base64Data, "base64");

        fs.writeFileSync(this.screenshotPath, buffer);
      } catch {
        // If screenshot save fails, don't break the error
        // Can't emit from constructor, just skip logging
      }
    }

    // Save cached image if available
    this.cachedImagePath = null;
    if (debugInfo.cachedImageUrl) {
      this.cachedImagePath = debugInfo.cachedImageUrl;
    }

    // Save pixel diff image if available
    this.pixelDiffPath = null;
    if (debugInfo.pixelDiffImage) {
      try {
        const tempDir = path.join(os.tmpdir(), "testdriver-debug");
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }

        const filename = `pixel-diff-error-${Date.now()}.png`;
        this.pixelDiffPath = path.join(tempDir, filename);

        const base64Data = debugInfo.pixelDiffImage.replace(
          /^data:image\/\w+;base64,/,
          "",
        );
        const buffer = Buffer.from(base64Data, "base64");

        fs.writeFileSync(this.pixelDiffPath, buffer);
      } catch {
        // Silently skip logging error from constructor
      }
    }

    // Extract similarity and input text from AI response
    const similarity = this.aiResponse?.similarity ?? null;
    const cacheHit =
      this.aiResponse?.cacheHit ?? this.aiResponse?.cached ?? false;
    const cacheStrategy = this.aiResponse?.cacheStrategy ?? null;
    const cacheCreatedAt = this.aiResponse?.cacheCreatedAt ?? null;
    const cacheDiffPercent = this.aiResponse?.cacheDiffPercent ?? null;
    const threshold = debugInfo.threshold ?? null;
    const inputText =
      this.aiResponse?.input_text ?? this.aiResponse?.element ?? null;

    // Enhance error message with debugging hints
    this.message += `\n\n=== Debug Information ===`;
    this.message += `\nElement searched for: "${this.description}"`;

    if (threshold !== null) {
      const similarityRequired = ((1 - threshold) * 100).toFixed(1);
      this.message += `\nCache threshold: ${threshold} (${similarityRequired}% similarity required)`;
    }

    if (cacheHit) {
      this.message += `\nCache: HIT`;
      if (cacheStrategy) {
        this.message += ` (${cacheStrategy} strategy)`;
      }
      if (cacheCreatedAt) {
        const cacheAge = Math.round(
          (Date.now() - new Date(cacheCreatedAt).getTime()) / 1000,
        );
        this.message += `\nCache created: ${new Date(cacheCreatedAt).toISOString()} (${cacheAge}s ago)`;
      }
      if (cacheDiffPercent !== null) {
        this.message += `\nCache pixel diff: ${(cacheDiffPercent * 100).toFixed(2)}%`;
      }
    } else {
      this.message += `\nCache: MISS`;
    }

    if (similarity !== null) {
      const similarityPercent = (similarity * 100).toFixed(2);
      this.message += `\nSimilarity score: ${similarityPercent}%`;

      if (threshold !== null && similarity < 1 - threshold) {
        this.message += ` (below threshold)`;
      }
    }

    if (inputText) {
      this.message += `\nInput text: "${inputText}"`;
    }

    if (this.screenshotPath) {
      this.message += `\nCurrent screenshot: ${this.screenshotPath}`;
    }

    if (this.cachedImagePath) {
      this.message += `\nCached image URL: ${this.cachedImagePath}`;
    }

    if (this.pixelDiffPath) {
      this.message += `\nPixel diff image: ${this.pixelDiffPath}`;
    }

    if (this.aiResponse) {
      const responseText =
        this.aiResponse.reasoning ||
        this.aiResponse.response?.content?.[0]?.text ||
        this.aiResponse.content?.[0]?.text ||
        "No detailed response available";
      this.message += `\n\nAI Response:\n${responseText}`;
    }

    // Clean up stack trace to only show userland code
    if (this.stack) {
      const lines = this.stack.split("\n");
      const filteredLines = [lines[0]]; // Keep error message line

      // Skip frames until we find userland code (not sdk.js internals)
      let foundUserland = false;
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];

        // Skip internal Element method frames (click, hover, etc.)
        if (
          line.includes("Element.click") ||
          line.includes("Element.hover") ||
          line.includes("Element.doubleClick") ||
          line.includes("Element.rightClick") ||
          line.includes("Element.mouseDown") ||
          line.includes("Element.mouseUp")
        ) {
          continue;
        }

        // Once we hit userland code, include everything from there
        if (!line.includes("sdk.js") || foundUserland) {
          foundUserland = true;
          filteredLines.push(line);
        }
      }

      this.stack = filteredLines.join("\n");
    }
  }

  /**
   * Sanitize AI response by removing large base64 data to prevent serialization issues
   * @private
   * @param {Object} response - AI response
   * @returns {Object} Sanitized response
   */
  _sanitizeAiResponse(response) {
    if (!response) return null;

    // Create shallow copy and remove large base64 fields
    const sanitized = { ...response };
    delete sanitized.croppedImage;
    delete sanitized.screenshot;
    delete sanitized.pixelDiffImage;
    // Keep cachedImageUrl as it's just a URL string, not base64 data

    return sanitized;
  }
}

/**
 * Custom error class for ai() failures
 * Includes task execution details and retry information
 */
class AIError extends Error {
  /**
   * @param {string} message - Error message
   * @param {Object} details - Additional details about the failure
   * @param {string} details.task - The task that was attempted
   * @param {number} details.tries - Number of check attempts made
   * @param {number} details.maxTries - Maximum tries that were allowed
   * @param {number} details.duration - Total execution time in milliseconds
   * @param {Error} [details.cause] - The underlying error that caused the failure
   */
  constructor(message, details = {}) {
    super(message);
    this.name = "AIError";
    this.task = details.task;
    this.tries = details.tries;
    this.maxTries = details.maxTries;
    this.duration = details.duration;
    this.cause = details.cause;
    this.timestamp = new Date().toISOString();

    // Capture stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AIError);
    }

    // Enhance error message with execution details
    this.message += `\n\n=== AI Execution Details ===`;
    this.message += `\nTask: "${this.task}"`;
    this.message += `\nTries: ${this.tries}/${this.maxTries}`;
    this.message += `\nDuration: ${this.duration}ms`;
    this.message += `\nTimestamp: ${this.timestamp}`;

    if (this.cause) {
      this.message += `\nUnderlying error: ${this.cause.message}`;
    }
  }
}

/**
 * Element class representing a located or to-be-located element
 */
class Element {
  constructor(description, sdk, system, commands) {
    this.description = description;
    this.sdk = sdk;
    this.system = system;
    this.commands = commands;
    this.coordinates = null;
    /* The above code is a JavaScript comment block that sets the `_found` property of an object to
    `false`. The code snippet does not contain any executable code, it is just a comment. */
    this._found = false;
    this._response = null;
    this._screenshot = null;
    this._threshold = null; // Store the threshold used for this find
  }

  /**
   * Check if element was found
   * @returns {boolean} True if element coordinates were located
   */
  found() {
    return this._found;
  }

  /**
   * Serialize element to JSON safely (removes circular references)
   * This is automatically called by JSON.stringify()
   * @returns {Object} Serializable representation of the element
   */
  toJSON() {
    const result = {
      description: this.description,
      coordinates: this.coordinates,
      found: this._found,
      threshold: this._threshold,
      x: this.coordinates?.x,
      y: this.coordinates?.y,
    };

    // Include response metadata if available
    if (this._response) {
      result.cache = {
        hit:
          this._response.cacheHit ||
          this._response.cache_hit ||
          this._response.cached ||
          false,
        strategy: this._response.cacheStrategy,
        createdAt: this._response.cacheCreatedAt,
        diffPercent: this._response.cacheDiffPercent,
        imageUrl: this._response.cachedImageUrl,
      };

      result.similarity = this._response.similarity;
      result.confidence = this._response.confidence;
      result.reasoning = this._response.reasoning;
      result.selector = this._response.selector;

      // Include AI response text if available
      if (this._response.response?.content?.[0]?.text) {
        result.aiResponse = this._response.response.content[0].text;
      }
    }

    return result;
  }

  /**
   * Find the element on screen
   * @param {string} [newDescription] - Optional new description to search for
   * @param {Object} [options] - Optional options object with cache thresholds, cacheKey, and/or timeout
   * @param {number} [options.timeout] - Max time in ms to poll for element (polls every 5 seconds)
   * @param {Object} [options.cache] - Cache configuration { thresholds: { screen, element } }
   * @returns {Promise<Element>} This element instance
   */
  async find(newDescription, options) {
    // Handle timeout/polling option (default: 30s)
    const timeout = typeof options === "object" && options?.timeout !== undefined
      ? options.timeout
      : 10000;
    if (timeout && timeout > 0) {
      return this._findWithTimeout(newDescription, options, timeout);
    }

    const description = newDescription || this.description;
    if (newDescription) {
      this.description = newDescription;
    }

    // Capture absolute timestamp at the very start of the command
    // Frontend will calculate relative time using: timestamp - replay.clientStartDate
    const absoluteTimestamp = Date.now();
    const startTime = absoluteTimestamp;
    let response = null;
    let findError = null;
    // Resolved find options, hoisted so they can be reported to interaction tracking
    let resolvedZoom = 0;
    let resolvedVerify = this.sdk.verifyDefault === true;

    const debugMode =
      process.env.VERBOSE || process.env.TD_DEBUG;

    // Log finding action
    const { events } = require("./agent/events.js");
    const findingMessage = formatter.formatElementFinding(description);
    this.sdk.emitter.emit(events.log.log, findingMessage);

    try {
      // Returns { imageKey } (fast S3-key path, no local round-trip) or
      // { image } (base64 fallback). See system.captureScreenImage.
      const imagePayload = await this.system.captureScreenImage();
      // Only store screenshot in DEBUG mode to prevent memory leaks
      if (debugMode && imagePayload.image) {
        this._screenshot = imagePayload.image;
      }

      // Handle options - can be a number (cacheThreshold) or object with cacheKey/cacheThreshold/cache
      let cacheKey = null;
      let cacheThreshold = null;
      let perCommandThresholds = null; // Per-command { screen, element } override
      let zoom = false; // Default to disabled
      // Default to global verifyDefault (set via SDK constructor { verify: true })
      let verify = this.sdk.verifyDefault === true;
      let perCommandAi = null; // Per-command AI config override

      let minConfidence = null; // Minimum confidence threshold
      let elementType = null; // Element type hint: "text", "image", "ui", or "any"

      if (typeof options === "number") {
        // Legacy: options is just a number threshold
        cacheThreshold = options;
      } else if (typeof options === "object" && options !== null) {
        // New: options is an object with cacheKey and/or cacheThreshold
        cacheKey = options.cacheKey || null;
        cacheThreshold = options.cacheThreshold ?? null;
        // zoom defaults to false unless explicitly set to true
        zoom = options.zoom === true;
        // verify defaults to global verifyDefault unless explicitly set per-call
        if (options.verify !== undefined) {
          verify = options.verify === true;
        }
        // Minimum confidence threshold: fail find if AI confidence is below this value
        minConfidence = options.confidence ?? null;
        // Element type hint for prompt wrapping
        elementType = options.type ?? null;
        // Per-command cache thresholds: { cache: { thresholds: { screen: 0.1, element: 0.2 } } }
        if (typeof options.cache === "object" && options.cache?.thresholds) {
          perCommandThresholds = options.cache.thresholds;
        }
      }

      // Use default cacheKey from SDK constructor if not provided in find() options
      // BUT only if cache is not explicitly disabled via cache: false option
      if (
        !cacheKey &&
        this.sdk.options?.cacheKey &&
        !this.sdk._cacheExplicitlyDisabled
      ) {
        cacheKey = this.sdk.options.cacheKey;
      }

      // Determine threshold:
      // - If cache is explicitly disabled, don't use cache even with cacheKey
      // - If cacheKey is provided, enable cache with threshold
      // - If no cacheKey, disable cache
      let threshold;
      let elementSimilarity;
      if (this.sdk._cacheExplicitlyDisabled) {
        // Cache explicitly disabled via cache: false option or TD_NO_CACHE env
        threshold = -1;
        elementSimilarity = -1;
        cacheKey = null; // Clear any cacheKey to ensure cache is truly disabled
      } else if (cacheKey) {
        // cacheKey provided - enable cache with threshold
        // Per-command thresholds > legacy cacheThreshold > global config
        threshold = perCommandThresholds?.screen ?? cacheThreshold ?? this.sdk.cacheConfig?.thresholds?.find?.screen ?? 0.05;
        elementSimilarity = perCommandThresholds?.element ?? this.sdk.cacheConfig?.thresholds?.find?.element ?? 0.9;
      } else if (cacheThreshold !== null) {
        // Explicit threshold provided without cacheKey
        threshold = perCommandThresholds?.screen ?? cacheThreshold;
        elementSimilarity = perCommandThresholds?.element ?? this.sdk.cacheConfig?.thresholds?.find?.element ?? 0.9;
      } else {
        // No cacheKey, no explicit threshold - disable cache
        threshold = -1;
        elementSimilarity = -1;
      }

      // Store the threshold for debugging
      this._threshold = threshold;

      // Debug log threshold
      if (debugMode) {
        const { events } = require("./agent/events.js");
        const autoGenMsg =
          this.sdk._autoGeneratedCacheKey &&
          cacheKey === this.sdk.options.cacheKey
            ? " (auto-generated from file hash)"
            : "";
        this.sdk.emitter.emit(
          events.log.debug,
          `🔍 find() threshold: ${threshold} (cache ${threshold < 0 ? "DISABLED" : "ENABLED"}${cacheKey ? `, cacheKey: ${cacheKey}${autoGenMsg}` : ""})`,
        );
      }

      // Remember the resolved options so click()/hover() and interaction
      // tracking can report what this find actually ran with
      const requestedZoom = typeof options === "object" && options !== null ? options.zoom : undefined;
      resolvedZoom = requestedZoom === true ? 1 : requestedZoom === false ? 0 : typeof requestedZoom === "number" ? requestedZoom : 0;
      resolvedVerify = verify;
      this._zoom = resolvedZoom;
      this._verify = resolvedVerify;

      response = await this.sdk.apiClient.req("find", {
        session: this.sdk.getSessionId(),
        element: description,
        ...imagePayload,
        threshold: threshold,
        elementSimilarity: elementSimilarity,
        cacheKey: cacheKey,
        os: this.sdk.os,
        resolution: this.sdk.resolution,
        zoom: resolvedZoom,
        skipVerify: !verify,
        confidence: minConfidence,
        type: elementType,
        ai: {
          ...this.sdk.aiConfig,
          ...(perCommandAi || {}),
          top: { ...this.sdk.aiConfig?.top, ...(perCommandAi?.top || {}) },
        },
      });

      const duration = Date.now() - startTime;

      if (response && response.coordinates) {
        // Store response but clear large base64 data to prevent memory leaks
        this._response = this._sanitizeResponse(response);
        this.coordinates = response.coordinates;
        this._found = true;

        // Log debug information when element is found
        this._logFoundDebug(response, duration);
      } else {
        this._response = this._sanitizeResponse(response);
        this._found = false;
        findError = "Element not found";

        // Log not found
        const duration = Date.now() - startTime;
        const { events } = require("./agent/events.js");
        const notFoundMessage = formatter.formatElementNotFound(description, {
          duration: `${duration}ms`,
        });
        this.sdk.emitter.emit(events.log.log, notFoundMessage);
      }
    } catch (error) {
      // A rejected or missing OpenRouter key breaks every find the same way.
      // Reporting it as "element not found" hides the one thing the user needs
      // to know, so it escapes instead of being folded into the not-found path.
      if (error.isConfigError) {
        const { events } = require("./agent/events.js");
        this.sdk.emitter.emit(
          events.log.log,
          formatter.formatError("Cannot run find()", error),
        );
        throw error;
      }

      this._response = error.response
        ? this._sanitizeResponse(error.response)
        : null;
      this._found = false;
      findError = error.message;
      response = error.response;

      // Log not found with error
      const duration = Date.now() - startTime;
      const { events } = require("./agent/events.js");
      const notFoundMessage = formatter.formatElementNotFound(description, {
        duration: `${duration}ms`,
        error: error.message,
      });
      this.sdk.emitter.emit(events.log.log, notFoundMessage);

      console.error("Error during find():", error);
    }

    // Track find interaction once at the end (fire-and-forget, don't block)
    const sessionId = this.sdk.getSessionId();
    const findCacheHit = response?.cacheHit || response?.cache_hit || response?.cached || false;
    // Increment local interaction counters
    this.sdk._interactionStats.total++;
    this.sdk._interactionStats.byType.find = (this.sdk._interactionStats.byType.find || 0) + 1;
    if (findCacheHit) this.sdk._interactionStats.cached++;
    if (sessionId && this.sdk.apiClient) {
      this.sdk.apiClient
        .req("interaction/track", {
          type: "find",
          session: sessionId,
          prompt: description,
          timestamp: absoluteTimestamp, // Absolute epoch timestamp - frontend calculates relative using clientStartDate
          success: this._found,
          error: findError,
          cacheHit: findCacheHit,
          coordinates: response?.coordinates ?? null,
          selector: response?.selector,
          selectorUsed: !!response?.selector,
          confidence: response?.confidence ?? null,
          reasoning: response?.reasoning ?? null,
          similarity: response?.similarity ?? null,
          screenshotUrl: response?.screenshotKey ?? null,
          zoom: resolvedZoom,
          verify: resolvedVerify,
        })
        .catch((err) => {
          console.warn("Failed to track find interaction:", err.message);
        });
    }

    return this;
  }

  /**
   * Find element with polling/timeout support
   * @private
   * @param {string} [newDescription] - Optional new description to search for
   * @param {Object} options - Options object
   * @param {number} timeout - Max time in ms to poll for element
   * @returns {Promise<Element>} This element instance
   */
  async _findWithTimeout(newDescription, options, timeout) {
    const POLL_INTERVAL = 5000; // 5 seconds between attempts
    const startTime = Date.now();
    const description = newDescription || this.description;

    // Log that we're starting a polling find
    const { events } = require("./agent/events.js");
    this.sdk.emitter.emit(
      events.log.log,
      `🔄 Polling for "${description}" (timeout: ${timeout}ms)`,
    );

    // Create options without timeout to avoid infinite recursion
    const findOptions = typeof options === "object" ? { ...options } : {};
    findOptions.timeout = 0;

    let attempts = 0;
    while (Date.now() - startTime < timeout) {
      attempts++;

      // Call the regular find (without timeout option)
      await this.find(newDescription, findOptions);

      if (this._found) {
        this.sdk.emitter.emit(
          events.log.log,
          `✅ Found "${description}" after ${attempts} attempt(s)`,
        );
        return this;
      }

      const elapsed = Date.now() - startTime;
      const remaining = timeout - elapsed;

      if (remaining > POLL_INTERVAL) {
        this.sdk.emitter.emit(
          events.log.log,
          `⏳ Element not found, retrying in 5s... (${Math.round(remaining / 1000)}s remaining)`,
        );
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
      } else if (remaining > 0) {
        // Less than 5s remaining, wait the remaining time and try once more
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }
    }

    // Final attempt after timeout
    await this.find(newDescription, findOptions);

    if (!this._found) {
      this.sdk.emitter.emit(
        events.log.log,
        `❌ Element "${description}" not found after ${timeout}ms (${attempts} attempts)`,
      );
    }

    return this;
  }

  /**
   * Sanitize response by removing large base64 data to prevent memory leaks
   * @private
   * @param {Object} response - API response
   * @returns {Object} Sanitized response
   */
  _sanitizeResponse(response) {
    if (!response) return null;

    // Only keep base64 data in DEBUG mode
    const debugMode =
      process.env.VERBOSE || process.env.TD_DEBUG;
    if (debugMode) {
      return response;
    }

    // Create shallow copy and remove large base64 fields
    const sanitized = { ...response };
    delete sanitized.croppedImage;
    delete sanitized.screenshot;

    return sanitized;
  }

  /**
   * Log debug information when element is successfully found
   * @private
   */
  async _logFoundDebug(response, duration) {
    const debugInfo = {
      description: this.description,
      coordinates: this.coordinates,
      duration: `${duration}ms`,
      cacheHit:
        response.cacheHit || response.cache_hit || response.cached || false,
      cacheStrategy: response.cacheStrategy || null,
      similarity: response.similarity ?? null,
      confidence: response.confidence ?? null,
      reasoning: response.reasoning ?? null,
    };

    // Emit element found as log:log event
    const { events } = require("./agent/events.js");
    const Dashcam = require("./lib/core/Dashcam");
    const consoleUrl = Dashcam.getConsoleUrl(this.sdk.config?.TD_API_ROOT);
    const meta = {
      x: this.coordinates.x,
      y: this.coordinates.y,
      duration: debugInfo.duration,
      cacheHit: debugInfo.cacheHit,
      selectorId: this._response?.selector,
      consoleUrl: consoleUrl,
      validated: response.validated ?? null,
      validationConfidence: response.validationConfidence ?? null,
      coordsUpdated: response.coordsUpdated ?? null,
    };
    if (!debugInfo.cacheHit) {
      meta.confidence = debugInfo.confidence;
      meta.reasoning = debugInfo.reasoning;
    }
    const formattedMessage = formatter.formatElementFound(this.description, meta);
    this.sdk.emitter.emit(events.log.log, formattedMessage);

    // Log cache information in debug mode
    const debugMode =
      process.env.VERBOSE || process.env.TD_DEBUG;
    if (debugMode) {
      const { events } = require("./agent/events.js");
      this.sdk.emitter.emit(events.log.debug, "Element Found:");
      this.sdk.emitter.emit(
        events.log.debug,
        `  Description: ${debugInfo.description}`,
      );
      this.sdk.emitter.emit(
        events.log.debug,
        `  Coordinates: (${this.coordinates.x}, ${this.coordinates.y})`,
      );
      this.sdk.emitter.emit(
        events.log.debug,
        `  Duration: ${debugInfo.duration}`,
      );
      this.sdk.emitter.emit(
        events.log.debug,
        `  Cache Hit: ${debugInfo.cacheHit ? "✅ YES" : "❌ NO"}`,
      );
      if (debugInfo.cacheHit) {
        this.sdk.emitter.emit(
          events.log.debug,
          `  Cache Strategy: ${debugInfo.cacheStrategy || "unknown"}`,
        );
        this.sdk.emitter.emit(
          events.log.debug,
          `  Similarity: ${debugInfo.similarity !== null ? (debugInfo.similarity * 100).toFixed(2) + "%" : "N/A"}`,
        );
        if (response.cacheCreatedAt) {
          const cacheAge = Math.round(
            (Date.now() - new Date(response.cacheCreatedAt).getTime()) / 1000,
          );
          this.sdk.emitter.emit(
            events.log.debug,
            `  Cache Age: ${cacheAge}s (created: ${new Date(response.cacheCreatedAt).toISOString()})`,
          );
        }
        if (response.cachedImageUrl) {
          this.sdk.emitter.emit(
            events.log.debug,
            `  Cached Image URL: ${response.cachedImageUrl}`,
          );
        }
        if (response.cacheDiffPercent !== undefined) {
          this.sdk.emitter.emit(
            events.log.debug,
            `  Pixel Diff: ${(response.cacheDiffPercent * 100).toFixed(2)}%`,
          );
        }
      }
      if (debugInfo.confidence !== null) {
        this.sdk.emitter.emit(
          events.log.debug,
          `  Confidence: ${(debugInfo.confidence * 100).toFixed(2)}%`,
        );
      }

      // Log available response fields for debugging
      this.sdk.emitter.emit(
        events.log.debug,
        `  Has croppedImage: ${!!response.croppedImage}`,
      );
      this.sdk.emitter.emit(
        events.log.debug,
        `  Has screenshot: ${!!response.screenshot}`,
      );
      this.sdk.emitter.emit(
        events.log.debug,
        `  Has cachedImageUrl: ${!!response.cachedImageUrl}`,
      );
      this.sdk.emitter.emit(
        events.log.debug,
        `  Has pixelDiffImage: ${!!response.pixelDiffImage}`,
      );
    }

    // Save cropped image with red circle if available
    let croppedImagePath = null;
    if (response.croppedImage) {
      try {
        const tempDir = path.join(os.tmpdir(), "testdriver-debug");
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }

        const filename = `element-found-${Date.now()}.png`;
        croppedImagePath = path.join(tempDir, filename);

        // Remove data:image/png;base64, prefix if present
        const base64Data = response.croppedImage.replace(
          /^data:image\/\w+;base64,/,
          "",
        );
        const buffer = Buffer.from(base64Data, "base64");

        fs.writeFileSync(croppedImagePath, buffer);

        if (debugMode) {
          const { events } = require("./agent/events.js");
          this.sdk.emitter.emit(
            events.log.debug,
            `  Debug Image: ${croppedImagePath}`,
          );
        }
      } catch (err) {
        const { events } = require("./agent/events.js");
        const errorMsg = formatter.formatError(
          "Failed to save debug image",
          err,
        );
        this.sdk.emitter.emit(events.log.log, errorMsg);
      }
    }

    // Save cached screenshot if available and this was a cache hit
    let cachedScreenshotPath = null;
    if (debugInfo.cacheHit && response.screenshot) {
      try {
        const tempDir = path.join(os.tmpdir(), "testdriver-debug");
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }

        const filename = `cached-screenshot-${Date.now()}.png`;
        cachedScreenshotPath = path.join(tempDir, filename);

        // Remove data:image/png;base64, prefix if present
        const base64Data = response.screenshot.replace(
          /^data:image\/\w+;base64,/,
          "",
        );
        const buffer = Buffer.from(base64Data, "base64");

        fs.writeFileSync(cachedScreenshotPath, buffer);

        if (debugMode) {
          const { events } = require("./agent/events.js");
          this.sdk.emitter.emit(
            events.log.debug,
            `  Cached Screenshot: ${cachedScreenshotPath}`,
          );
        }
      } catch (err) {
        const { events } = require("./agent/events.js");
        const errorMsg = formatter.formatError(
          "Failed to save cached screenshot",
          err,
        );
        this.sdk.emitter.emit(events.log.log, errorMsg);
      }
    }

    // Save pixel diff image if available and this was a cache hit
    let pixelDiffPath = null;
    if (debugInfo.cacheHit && response.pixelDiffImage) {
      try {
        const tempDir = path.join(os.tmpdir(), "testdriver-debug");
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }

        const filename = `pixel-diff-${Date.now()}.png`;
        pixelDiffPath = path.join(tempDir, filename);

        // Remove data:image/png;base64, prefix if present
        const base64Data = response.pixelDiffImage.replace(
          /^data:image\/\w+;base64,/,
          "",
        );
        const buffer = Buffer.from(base64Data, "base64");

        fs.writeFileSync(pixelDiffPath, buffer);

        if (debugMode) {
          const { events } = require("./agent/events.js");
          this.sdk.emitter.emit(
            events.log.debug,
            `  Pixel Diff Image: ${pixelDiffPath}`,
          );
        }
      } catch (err) {
        const { events } = require("./agent/events.js");
        const errorMsg = formatter.formatError(
          "Failed to save pixel diff image",
          err,
        );
        this.sdk.emitter.emit(events.log.log, errorMsg);
      }
    }
  }

  /**
   * Click on the element
   * @param {ClickAction} [action='click'] - Type of click action
   * @returns {Promise<Element>} This element instance for chaining
   */
  async click(action = "click") {
    if (!this._found || !this.coordinates) {
      throw new ElementNotFoundError(
        `Element "${this.description}" not found.`,
        {
          description: this.description,
          aiResponse: this._response,
          threshold: this._threshold,
        },
      );
    }

    // Log the action
    const { events } = require("./agent/events.js");
    const actionName = action === "click" ? "click" : action.replace("-", " ");
    const formattedMessage = formatter.formatAction(
      actionName,
      this.description,
    );
    this.sdk.emitter.emit(events.log.log, formattedMessage);

    // Prepare element metadata for interaction tracking
    const elementData = {
      prompt: this.description,
      elementType: this._response?.elementType,
      elementBounds: this._response?.elementBounds,
      croppedImageUrl: this._response?.savedImagePath,
      edgeDetectedImageUrl: this._response?.edgeSavedImagePath || null,
      cacheHit: this._response?.cacheHit,
      selectorUsed: !!this._response?.selector,
      selector: this._response?.selector,
      confidence: this._response?.confidence ?? null,
      reasoning: this._response?.reasoning ?? null,
      similarity: this._response?.similarity ?? null,
      screenshotUrl: this._response?.screenshotKey ?? null,
      zoom: this._zoom ?? null,
      verify: this._verify ?? null,
    };

    if (action === "hover") {
      await this.commands.hover(
        this.coordinates.x,
        this.coordinates.y,
        elementData,
      );
    } else {
      await this.commands.click(
        this.coordinates.x,
        this.coordinates.y,
        action,
        elementData,
      );
    }
    
    return this;
  }

  /**
   * Hover over the element
   * @returns {Promise<Element>} This element instance for chaining
   */
  async hover() {
    if (!this._found || !this.coordinates) {
      throw new ElementNotFoundError(
        `Element "${this.description}" not found.`,
        {
          description: this.description,
          aiResponse: this._response,
          threshold: this._threshold,
        },
      );
    }

    // Log the hover action
    const { events } = require("./agent/events.js");
    const formattedMessage = formatter.formatAction("hover", this.description);
    this.sdk.emitter.emit(events.log.log, formattedMessage);

    // Prepare element metadata for interaction tracking
    const elementData = {
      prompt: this.description,
      elementType: this._response?.elementType,
      elementBounds: this._response?.elementBounds,
      croppedImageUrl: this._response?.savedImagePath,
      edgeDetectedImageUrl: this._response?.edgeSavedImagePath || null,
      cacheHit: this._response?.cacheHit,
      selectorUsed: !!this._response?.selector,
      selector: this._response?.selector,
      confidence: this._response?.confidence ?? null,
      reasoning: this._response?.reasoning ?? null,
      similarity: this._response?.similarity ?? null,
      screenshotUrl: this._response?.screenshotKey ?? null,
      zoom: this._zoom ?? null,
      verify: this._verify ?? null,
    };

    await this.commands.hover(
      this.coordinates.x,
      this.coordinates.y,
      elementData,
    );
    
    return this;
  }

  /**
   * Double-click on the element
   * @returns {Promise<Element>} This element instance for chaining
   */
  async doubleClick() {
    return this.click("double-click");
  }

  /**
   * Right-click on the element
   * @returns {Promise<Element>} This element instance for chaining
   */
  async rightClick() {
    return this.click("right-click");
  }

  /**
   * Press mouse button down on this element
   * @returns {Promise<Element>} This element instance for chaining
   */
  async mouseDown() {
    return this.click("mouseDown");
  }

  /**
   * Release mouse button on this element
   * @returns {Promise<Element>} This element instance for chaining
   */
  async mouseUp() {
    return this.click("mouseUp");
  }

  /**
   * Get the coordinates of the element
   * @returns {{x: number, y: number, centerX: number, centerY: number}|null}
   */
  getCoordinates() {
    return this.coordinates;
  }

  /**
   * Get the x coordinate (top-left)
   * @returns {number|null}
   */
  get x() {
    return this.coordinates?.x ?? null;
  }

  /**
   * Get the y coordinate (top-left)
   * @returns {number|null}
   */
  get y() {
    return this.coordinates?.y ?? null;
  }

  /**
   * Get the center x coordinate
   * @returns {number|null}
   */
  get centerX() {
    return this.coordinates?.centerX ?? null;
  }

  /**
   * Get the center y coordinate
   * @returns {number|null}
   */
  get centerY() {
    return this.coordinates?.centerY ?? null;
  }

  /**
   * Get the full API response data
   * @returns {Object|null}
   */
  getResponse() {
    return this._response;
  }

  /**
   * Get element screenshot if available
   * @returns {string|null} Base64 encoded screenshot
   */
  get screenshot() {
    return this._response?.screenshot ?? null;
  }

  /**
   * Get element confidence score if available
   * @returns {number|null}
   */
  get confidence() {
    return this._response?.confidence ?? null;
  }

  /**
   * Get model reasoning for why this element was selected
   * @returns {string|null}
   */
  get reasoning() {
    return this._response?.reasoning ?? null;
  }

  /**
   * Get element width if available
   * @returns {number|null}
   */
  get width() {
    return this._response?.width ?? null;
  }

  /**
   * Get element height if available
   * @returns {number|null}
   */
  get height() {
    return this._response?.height ?? null;
  }

  /**
   * Get element bounding box if available
   * @returns {Object|null}
   */
  get boundingBox() {
    return this._response?.boundingBox ?? null;
  }

  /**
   * Get element text content if available
   * @returns {string|null}
   */
  get text() {
    return this._response?.text ?? null;
  }

  /**
   * Get element label if available
   * @returns {string|null}
   */
  get label() {
    return this._response?.label ?? null;
  }

  /**
   * Save the debug screenshot to a file for manual inspection
   * @param {string} [filepath] - Path to save the screenshot (defaults to ./debug-screenshot-{timestamp}.png)
   * @returns {Promise<string>} Path to the saved screenshot
   */
  async saveDebugScreenshot(filepath) {
    if (!this._screenshot) {
      throw new Error("No screenshot available.");
    }

    const fs = require("fs").promises;
    const path = require("path");

    const defaultPath = `./debug-screenshot-${Date.now()}.png`;
    const savePath = filepath || defaultPath;

    // Remove data:image/png;base64, prefix if present
    const base64Data = this._screenshot.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Data, "base64");

    await fs.writeFile(savePath, buffer);
    return path.resolve(savePath);
  }

  /**
   * Get debug information about the last find operation
   * @returns {Object} Debug information including AI response and screenshot metadata
   */
  getDebugInfo() {
    return {
      description: this.description,
      found: this._found,
      coordinates: this.coordinates,
      aiResponse: this._response,
      hasScreenshot: !!this._screenshot,
      screenshotSize: this._screenshot ? this._screenshot.length : 0,
    };
  }

  /**
   * Clean up element resources to prevent memory leaks
   * Call this when you're done with the element
   */
  destroy() {
    this._screenshot = null;
    this._response = null;
    this.coordinates = null;
    this.sdk = null;
    this.system = null;
    this.commands = null;
  }
}

/**
 * Creates a chainable promise that allows method chaining on find() results
 * This enables syntax like: await testdriver.find("button").click()
 *
 * @param {Promise<Element>} promise - The promise that resolves to an Element
 * @returns {Promise<Element> & ChainableElement} A promise with chainable element methods
 */
function createChainablePromise(promise) {
  // Define the chainable methods that should be available
  const chainableMethods = [
    "click",
    "hover",
    "doubleClick",
    "rightClick",
    "mouseDown",
    "mouseUp",
  ];

  // Create a new promise that wraps the original
  const chainablePromise = promise.then((element) => element);

  // Add chainable methods to the promise
  for (const method of chainableMethods) {
    chainablePromise[method] = function (...args) {
      // Return a promise that waits for the element, then calls the method
      return promise.then((element) => element[method](...args));
    };
  }

  // Add getters for element properties (these return promises)
  Object.defineProperty(chainablePromise, "x", {
    get() {
      return promise.then((el) => el.x);
    },
  });
  Object.defineProperty(chainablePromise, "y", {
    get() {
      return promise.then((el) => el.y);
    },
  });
  Object.defineProperty(chainablePromise, "centerX", {
    get() {
      return promise.then((el) => el.centerX);
    },
  });
  Object.defineProperty(chainablePromise, "centerY", {
    get() {
      return promise.then((el) => el.centerY);
    },
  });

  // Add found() method
  chainablePromise.found = function () {
    return promise.then((el) => el.found());
  };

  // Add getCoordinates() method
  chainablePromise.getCoordinates = function () {
    return promise.then((el) => el.getCoordinates());
  };

  // Add getResponse() method
  chainablePromise.getResponse = function () {
    return promise.then((el) => el.getResponse());
  };

  return chainablePromise;
}

/**
 * Normalize redraw options from new thresholds format or legacy format to internal format.
 * New:    { enabled: true, thresholds: { screen: 0.05, network: true } }
 * Legacy: { enabled: true, diffThreshold: 0.1, screenRedraw: true, networkMonitor: true }
 * Internal: { enabled: true, screenRedraw: true, networkMonitor: false }
 * @param {Object} opts - raw redraw options
 * @returns {Object} normalised options the redraw subsystem expects
 */
function normalizeRedrawOptions(opts) {
  if (!opts || typeof opts !== "object") {
    return { enabled: !!opts };
  }

  const result = { enabled: opts.enabled !== false };

  // New thresholds format takes precedence
  if (opts.thresholds && typeof opts.thresholds === "object") {
    result.screenRedraw = opts.thresholds.screen !== false;
    result.networkMonitor = !!opts.thresholds.network;
  } else {
    // Legacy format fallback
    result.screenRedraw = opts.screenRedraw !== undefined ? opts.screenRedraw : true;
    result.networkMonitor = opts.networkMonitor !== undefined ? opts.networkMonitor : false;
  }

  return result;
}

/**
 * TestDriver SDK
 *
 * This SDK provides programmatic access to TestDriver's AI-powered testing capabilities.
 * Automatically loads environment variables from .env file via dotenv.
 *
 * @example
 * const TestDriver = require('testdriverai');
 *
 * // API key loaded automatically from TD_API_KEY in .env
 * const client = new TestDriver();
 * await client.connect();
 *
 * // Pass options only (API key from .env)
 * const client = new TestDriver({ os: 'windows' });
 *
 * // Or pass API key explicitly
 * const client = new TestDriver('your-api-key');
 *
 * // New API
 * const element = await client.find('Submit button');
 * await element.click();
 */

/**
 * @typedef {'click' | 'right-click' | 'double-click' | 'hover' | 'mouseDown' | 'mouseUp'} ClickAction
 * @typedef {'up' | 'down' | 'left' | 'right'} ScrollDirection
 * @typedef {'keyboard' | 'mouse'} ScrollMethod
 * @typedef {'ai' | 'turbo'} TextMatchMethod
 * @typedef {'sh' | 'pwsh'} ExecLanguage
 * @typedef {'\\t' | '\n' | '\r' | ' ' | '!' | '"' | '#' | '$' | '%' | '&' | "'" | '(' | ')' | '*' | '+' | ',' | '-' | '.' | '/' | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | ':' | ';' | '<' | '=' | '>' | '?' | '@' | '[' | '\\' | ']' | '^' | '_' | '`' | 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm' | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z' | '{' | '|' | '}' | '~' | 'accept' | 'add' | 'alt' | 'altleft' | 'altright' | 'apps' | 'backspace' | 'browserback' | 'browserfavorites' | 'browserforward' | 'browserhome' | 'browserrefresh' | 'browsersearch' | 'browserstop' | 'capslock' | 'clear' | 'convert' | 'ctrl' | 'ctrlleft' | 'ctrlright' | 'decimal' | 'del' | 'delete' | 'divide' | 'down' | 'end' | 'enter' | 'esc' | 'escape' | 'execute' | 'f1' | 'f10' | 'f11' | 'f12' | 'f13' | 'f14' | 'f15' | 'f16' | 'f17' | 'f18' | 'f19' | 'f2' | 'f20' | 'f21' | 'f22' | 'f23' | 'f24' | 'f3' | 'f4' | 'f5' | 'f6' | 'f7' | 'f8' | 'f9' | 'final' | 'fn' | 'hanguel' | 'hangul' | 'hanja' | 'help' | 'home' | 'insert' | 'junja' | 'kana' | 'kanji' | 'launchapp1' | 'launchapp2' | 'launchmail' | 'launchmediaselect' | 'left' | 'modechange' | 'multiply' | 'nexttrack' | 'nonconvert' | 'num0' | 'num1' | 'num2' | 'num3' | 'num4' | 'num5' | 'num6' | 'num7' | 'num8' | 'num9' | 'numlock' | 'pagedown' | 'pageup' | 'pause' | 'pgdn' | 'pgup' | 'playpause' | 'prevtrack' | 'print' | 'printscreen' | 'prntscrn' | 'prtsc' | 'prtscr' | 'return' | 'right' | 'scrolllock' | 'select' | 'separator' | 'shift' | 'shiftleft' | 'shiftright' | 'sleep' | 'space' | 'stop' | 'subtract' | 'tab' | 'up' | 'volumedown' | 'volumemute' | 'volumeup' | 'win' | 'winleft' | 'winright' | 'yen' | 'command' | 'option' | 'optionleft' | 'optionright'} KeyboardKey
 */

const TestDriverAgent = require("./agent/index.js");
const { events } = require("./agent/events.js");
const { createMarkdownLogger } = require("./interfaces/logger.js");

// Track screenshot directories already cleaned in this process to avoid
// concurrent tests in the same file from nuking each other's screenshots.
const _cleanedScreenshotDirs = new Set();

class TestDriverSDK {
  constructor(apiKey, options = {}) {
    // Support calling with just options: new TestDriver({ os: 'windows' })
    if (typeof apiKey === 'object' && apiKey !== null) {
      options = apiKey;
      apiKey = null;
    }

    // Use provided API key or fall back to environment variable
    const resolvedApiKey = apiKey || process.env.TD_API_KEY;

    // Handle preview mode with backwards compatibility for headless option
    // Preview  can be "browser" (default), "ide", or "none" (headless)
    let previewMode = options.preview || process.env.TD_PREVIEW;
    
    // Backwards compatibility: headless: true maps to preview: "none"
    // headless: true takes precedence over any preview setting
    if (options.headless === true) {
      previewMode = "none";
    } else if (!previewMode) {
      previewMode = "browser"; // default
    }

    // Set up environment with API key
    const channelConfig = require("./lib/resolve-channel.js");
    const environment = {
      TD_API_KEY: resolvedApiKey,
      TD_API_ROOT: options.apiRoot || process.env.TD_API_ROOT || channelConfig.channels[channelConfig.active],
      TD_RESOLUTION: options.resolution || "1366x768",
      TD_ANALYTICS: options.analytics !== false,
      TD_PREVIEW: previewMode,
      ...options.environment,
    };

    // Auto-detect CI environment (GitHub Actions, etc.) and pass through
    // This ensures the API creates fresh sandboxes instead of reusing hot-pool instances
    if (!environment.CI && process.env.CI) {
      environment.CI = process.env.CI;
    }

    // Create the underlying agent with minimal CLI args
    this.agent = new TestDriverAgent(environment, {
      command: "sdk",
      args: [],
      options: {
        os: options.os || "linux",
        preview: previewMode,
      },
    });

    // Auto-generate cache key from caller file hash if not explicitly provided
    // This allows caching to be tied to the specific test file
    if (!options.cacheKey) {
      const autoGeneratedKey = getCallerFileHash();
      if (autoGeneratedKey) {
        options.cacheKey = autoGeneratedKey;
        // Store flag to indicate this was auto-generated
        this._autoGeneratedCacheKey = true;
      }
    }

    // Store options for later use
    this.options = options;

    // Store os and resolution for API requests
    this.os = options.os || "linux";
    this.resolution = options.resolution || "1366x768";

    // Store newSandbox preference from options
    this.newSandbox =
      options.newSandbox !== undefined ? options.newSandbox : true;

    // Store headless preference from options
    this.headless = options.headless !== undefined ? options.headless : false;

    // Store IP address if provided for direct connection
    this.ip = options.ip || null;

    // Store EC2 instance ID for direct connections (used to provision Ably credentials via SSM)
    this.instanceId = options.instanceId || null;

    // Store sandbox configuration options
    this.sandboxAmi = options.sandboxAmi || null;
    this.sandboxInstance = options.sandboxInstance || null;
    this.e2bTemplateId = options.e2bTemplateId || null;

    // Store reconnect preference from options
    this.reconnect =
      options.reconnect !== undefined ? options.reconnect : false;

    // Explicit sandbox id to reconnect to (overrides last-sandbox file)
    this.sandboxId = options.sandboxId || null;

    // When reconnect is requested, an explicit sandboxId implies newSandbox=false.
    // If reconnect:true but no sandboxId given, try to load from .testdriver/last-sandbox.
    if (this.reconnect && !this.sandboxId) {
      const last = TestDriverSDK._readLastSandbox();
      if (last && last.sandboxId) {
        this.sandboxId = last.sandboxId;
      }
    }
    if (this.sandboxId && options.newSandbox === undefined) {
      this.newSandbox = false;
    }

    // Store keepAlive preference from options
    this.keepAlive =
      options.keepAlive !== undefined ? options.keepAlive : undefined;

    // Store dashcam preference (default: true)
    this.dashcamEnabled = options.dashcam !== false;

    // Cache threshold configuration
    // threshold = pixel difference allowed (0.05 = 5% difference, 95% similarity)
    // By default, cache is DISABLED (threshold = -1) to avoid unnecessary AI costs
    // To enable cache, provide a cacheKey when calling find() or findAll()
    // Also support TD_NO_CACHE environment variable and cache: false option for backwards compatibility
    const cacheExplicitlyDisabled =
      options.cache === false || process.env.TD_NO_CACHE === "true";

    // Track whether cache was explicitly disabled (not just default)
    this._cacheExplicitlyDisabled = cacheExplicitlyDisabled;

    if (cacheExplicitlyDisabled) {
      // Explicit cache disabled via option or env var
      this.cacheThresholds = {
        find: -1,
        findAll: -1,
        assert: -1,
      };
      this.cacheConfig = {
        enabled: false,
        thresholds: {
          find: { screen: -1, element: -1 },
          assert: -1,
        },
      };
    } else {
      // Support cache object format: { cache: { thresholds: { find: { screen: 0.05, element: 0.8 }, assert: 0.05 } } }
      const cacheOpts = typeof options.cache === "object" ? options.cache : {};
      const thresholds = cacheOpts.thresholds || {};
      const findThresholds = typeof thresholds.find === "object" ? thresholds.find : {};

      this.cacheConfig = {
        enabled: cacheOpts.enabled !== false,
        thresholds: {
          find: {
            screen: findThresholds.screen ?? 0.05, // Default: 5% pixel diff allowed
            element: findThresholds.element ?? 0.8, // Default: 80% OpenCV correlation
          },
          assert: thresholds.assert ?? 0.05, // Default: 5% pixel diff for assertions
        },
      };

      // Legacy cacheThresholds - keep for backwards compatibility
      this.cacheThresholds = {
        find: options.cacheThreshold?.find ?? this.cacheConfig.thresholds.find.screen,
        findAll: options.cacheThreshold?.findAll ?? this.cacheConfig.thresholds.find.screen,
        assert: options.cacheThreshold?.assert ?? this.cacheConfig.thresholds.assert,
      };
    }

    // AI sampling configuration
    // Supports: { ai: { temperature: 0, top: { p: 1, k: 0 } } }
    // Can be overridden per find() or assert() call
    this.aiConfig = typeof options.ai === "object" ? {
      temperature: options.ai.temperature,
      top: {
        p: options.ai.top?.p,
        k: options.ai.top?.k,
      },
    } : {};

    // Global AI verification default for find()
    // When true, every find() verifies located coordinates unless overridden per-call.
    // Can be overridden per find() call via { verify: true|false }.
    this.verifyDefault = options.verify === true;

    // Redraw configuration
    // Supports:
    //   - redraw: { enabled: true, thresholds: { screen: 0.05, network: true } }  (new)
    //   - redraw: true/false  (shorthand)
    //   - redraw: { enabled: true, diffThreshold: 0.1, screenRedraw: true, networkMonitor: true }  (legacy)
    //   - redrawThreshold: 0.1  (legacy, deprecated)
    if (options.redraw !== undefined) {
      if (typeof options.redraw === "object") {
        this.redrawOptions = normalizeRedrawOptions(options.redraw);
      } else {
        this.redrawOptions = { enabled: !!options.redraw };
      }
    } else if (options.redrawThreshold !== undefined) {
      // Legacy API: redrawThreshold number or object (deprecated)
      this.redrawOptions =
        typeof options.redrawThreshold === "object"
          ? normalizeRedrawOptions(options.redrawThreshold)
          : { enabled: true, screenRedraw: true, networkMonitor: false };
    } else {
      // Default: disabled (as of v7.3)
      this.redrawOptions = { enabled: false };
    }
    // Keep redrawThreshold for backwards compatibility in connect()
    this.redrawThreshold = this.redrawOptions;

    // Track connection state
    this.connected = false;
    this.authenticated = false;

    // Expose commonly used agent properties
    this.emitter = this.agent.emitter;
    this.config = this.agent.config;
    this.session = this.agent.session;
    this.apiClient = this.agent.sdk;
    this.analytics = this.agent.analytics;
    this.sandbox = this.agent.sandbox;
    this.system = this.agent.system;
    this.instance = null;

    // Commands will be set up dynamically after connection
    this.commands = null;

    // Set up logging if enabled (after emitter is exposed)
    this.loggingEnabled = options.logging !== false;

    // Log buffer: structured entries collected during test execution.
    // Uploaded to S3 at cleanup so they can be displayed alongside dashcam replays.
    this._logBuffer = [];

    // API version discovered by _logEnvironmentInfo()
    this._apiVersion = null;

    // Local interaction counters — incremented at each interaction/track call site
    this._interactionStats = { total: 0, cached: 0, byType: {} };

    // Set up event listeners once (they live for the lifetime of the SDK instance)
    this._setupLogging();

    // Set up provision API
    this.provision = this._createProvisionAPI();

    // Set up dashcam API lazily
    this._dashcam = null;

    // Last-promise tracking for unawaited promise detection
    this._lastPromiseSettled = true;
    this._lastCommandName = null;

    // Auto-screenshots configuration
    // When enabled, automatically captures screenshots before/after each command
    // Screenshots are saved to .testdriver/screenshots/<test>/ with descriptive names
    this.autoScreenshots = options.autoScreenshots === true;
    this._screenshotSequence = 0; // Counter for sequential screenshot naming

    // Set up command methods that lazy-await connection
    this._setupCommandMethods();
  }

  /**
   * Wait for the sandbox connection to complete
   * @returns {Promise<void>}
   */
  async ready() {
    if (this.__connectionPromise) {
      await this.__connectionPromise;
    }
    if (!this.connected) {
      throw new Error("Not connected to sandbox. Call connect() first.");
    }
  }

  /**
   * Get or create the Dashcam instance
   * @returns {Dashcam} Dashcam instance (or no-op stub if dashcam is disabled)
   */
  get dashcam() {
    if (!this._dashcam) {
      // If dashcam is disabled, return a no-op stub
      if (!this.dashcamEnabled) {
        this._dashcam = {
          start: async () => {},
          stop: async () => null,
          auth: async () => {},
          addFileLog: async () => {},
          addWebLog: async () => {},
          addApplicationLog: async () => {},
          addLog: async () => {},
          isRecording: async () => false,
          getElapsedTime: () => null,
          recording: false,
          url: null,
        };
      } else {
        const { Dashcam } = require("./lib/core/index.js");
        // Don't pass apiKey - let Dashcam use its default key
        this._dashcam = new Dashcam(this);
      }
    }
    return this._dashcam;
  }

  /**
   * Get milliseconds elapsed since dashcam started recording
   * @returns {number|null} Milliseconds since dashcam start, or null if not recording
   */
  getDashcamElapsedTime() {
    if (this._dashcam) {
      return this._dashcam.getElapsedTime();
    }
    return null;
  }

  /**
   * Create the provision API with methods for launching applications
   * Automatically skips provisioning when reconnect mode is enabled
   * @private
   */
  /**
   * Get the path to the dashcam-chrome extension
   * Uses preinstalled dashcam-chrome on both Linux and Windows
   * @returns {Promise<string>} Path to dashcam-chrome/build directory
   * @private
   */
  async _getDashcamChromeExtensionPath() {
    if (this.os !== "windows") {
      return "/usr/lib/node_modules/dashcam-chrome/build";
    }

    // dashcam-chrome is preinstalled on Windows at C:\Program Files\nodejs\node_modules\dashcam-chrome\build
    // Use the actual long path - we'll handle quoting in the chrome launch
    return "C:\\PROGRA~1\\nodejs\\node_modules\\dashcam-chrome\\build";
  }

  /**
   * Extract domain pattern from a URL for web log tracking
   * @param {string} url - The URL to extract domain from
   * @returns {string} Domain pattern (e.g., "*://example.com/*")
   * @private
   */
  _getUrlDomainPattern(url) {
    try {
      const parsed = new URL(url);
      // Use wildcard scheme and path to match all pages on the domain
      return `*://${parsed.hostname}*`;
    } catch (e) {
      // Fallback to ** if URL parsing fails
      console.warn(`[_getUrlDomainPattern] Failed to parse URL "${url}", using ** pattern`);
      return "**";
    }
  }

  /**
   * Wait for Chrome DevTools Protocol debugger to be ready on port 9222,
   * then wait for a page to report loaded.
   * Works on both Windows (PowerShell) and Linux (sh).
   * @param {number} [timeoutMs=60000] - Maximum time to wait in ms
   * @returns {Promise<void>}
   */
  async _waitForChromeDebuggerReady(timeoutMs = 60000) {
    const shell = this.os === "windows" ? "pwsh" : "sh";
    // PowerShell: Use async connect with 2-second timeout to match Linux curl behavior.
    // TcpClient.Connect() is synchronous and can hang indefinitely, causing exec timeouts.
    const portCheckCmd = this.os === "windows"
      ? `$tcp = New-Object System.Net.Sockets.TcpClient; $tcp.Connect('127.0.0.1', 9222); $tcp.Close(); echo 'open'`
      : `curl -s -o /dev/null --connect-timeout 2 http://localhost:9222 2>/dev/null && echo 'open' || echo 'closed'`;

    const deadline = Date.now() + timeoutMs;

    // Use commands.exec directly to bypass auto-screenshots wrapper.
    // The polling loop fires many rapid exec calls with short timeouts;
    // going through the wrapper adds 2-3 extra sandbox messages
    // (screenshot before/after/error) per iteration, overwhelming the
    // WebSocket and generating cascading "No pending promise" warnings
    // when timed-out responses arrive after the promise has been cleaned up.
    const execDirect = this.commands?.exec
      ? (...args) => this.commands.exec(...args)
      : (...args) => this.exec(...args); // fallback if commands not ready

    // Wait for port 9222 to be listening
    let portReady = false;
    while (Date.now() < deadline) {
      try {
        const result = await execDirect(shell, portCheckCmd, 10000, true);
        if (result && result.includes("open")) {
          portReady = true;
          break;
        }
      } catch (_) {
        // Port not ready yet
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!portReady) {
      throw new Error(
        `Chrome debugger port 9222 did not become available within ${timeoutMs}ms`,
      );
    }

  }

  _createProvisionAPI() {
    return createProvisionAPI(this);
  }

  /**
   * Solve a captcha on the current page using 2captcha service
   * Requires Chrome to be launched with remote debugging (--remote-debugging-port=9222)
   *
   * @param {Object} options - Captcha solving options
   * @param {string} options.apiKey - 2captcha API key (required)
   * @param {string} [options.sitekey] - Captcha sitekey (auto-detected if not provided)
   * @param {string} [options.type='recaptcha_v3'] - Captcha type: 'recaptcha_v2', 'recaptcha_v3', 'hcaptcha', 'turnstile'
   * @param {string} [options.action='verify'] - Action parameter for reCAPTCHA v3
   * @param {boolean} [options.autoSubmit=true] - Automatically click submit button after solving
   * @param {number} [options.pollInterval=5000] - Polling interval in ms for 2captcha
   * @param {number} [options.timeout=120000] - Timeout in ms for solving
   * @returns {Promise<{success: boolean, message: string, token?: string}>}
   *
   * @example
   * // Auto-detect and solve captcha
   * await testdriver.captcha({
   *   apiKey: 'your-2captcha-api-key'
   * });
   *
   * @example
   * // Solve with known sitekey
   * await testdriver.captcha({
   *   apiKey: 'your-2captcha-api-key',
   *   sitekey: '6LfB5_IbAAAAAMCtsjEHEHKqcB9iQocwwxTiihJu',
   *   action: 'demo_action'
   * });
   */
  async captcha(options = {}) {
    const {
      apiKey,
      sitekey,
      type = "recaptcha_v3",
      action = "verify",
      autoSubmit = true,
      pollInterval = 5000,
      timeout = 120000,
    } = options;

    if (!apiKey) {
      throw new Error(
        "[captcha] apiKey is required. Get your API key at https://2captcha.com",
      );
    }

    const shell = this.os === "windows" ? "pwsh" : "sh";
    const isWindows = this.os === "windows";

    // Paths for config and solver script
    const configPath = isWindows
      ? "C:\\Users\\testdriver\\AppData\\Local\\Temp\\td-captcha-config.json"
      : "/tmp/td-captcha-config.json";
    const solverPath = isWindows
      ? "C:\\Users\\testdriver\\AppData\\Local\\Temp\\td-captcha-solver.js"
      : "/tmp/td-captcha-solver.js";

    // Ensure chrome-remote-interface is installed
    if (isWindows) {
      await this.exec(
        shell,
        "npm install -g chrome-remote-interface 2>$null; $true",
        60000,
        true,
      );
    } else {
      await this.exec(
        shell,
        "sudo npm install -g chrome-remote-interface 2>/dev/null || npm install -g chrome-remote-interface",
        60000,
        true,
      );
    }

    // Build config JSON for the solver
    const config = JSON.stringify({
      apiKey,
      sitekey: sitekey || null,
      type,
      action,
      autoSubmit,
      pollInterval,
      timeout,
    });

    // Write config file
    if (isWindows) {
      // Use PowerShell's Set-Content with escaped JSON
      const escapedConfig = config.replace(/'/g, "''");
      await this.exec(
        shell,
        `[System.IO.File]::WriteAllText('${configPath}', '${escapedConfig}')`,
        5000,
        true,
      );
    } else {
      // Use heredoc for Linux
      await this.exec(
        shell,
        `cat > ${configPath} << 'CONFIGEOF'
${config}
CONFIGEOF`,
        5000,
        true,
      );
    }

    // Load the solver script from file (avoids escaping issues with string concatenation)
    const solverScriptPath = path.join(
      __dirname,
      "lib",
      "captcha",
      "solver.js",
    );
    const solverScript = fs.readFileSync(solverScriptPath, "utf8");

    // Write the solver script to sandbox
    if (isWindows) {
      // For Windows, write the script using base64 encoding to avoid escaping issues
      const base64Script = Buffer.from(solverScript).toString("base64");
      await this.exec(
        shell,
        `[System.IO.File]::WriteAllBytes('${solverPath}', [System.Convert]::FromBase64String('${base64Script}'))`,
        10000,
        true,
      );
    } else {
      // Use heredoc for Linux
      await this.exec(
        shell,
        `cat > ${solverPath} << 'CAPTCHA_SOLVER_EOF'
${solverScript}
CAPTCHA_SOLVER_EOF`,
        10000,
        true,
      );
    }

    // Run the solver (capture output even on failure)
    let result;
    try {
      if (isWindows) {
        // Set environment variable and run node on Windows
        result = await this.exec(
          shell,
          `$env:NODE_PATH = (npm root -g).Trim(); $env:TD_CAPTCHA_CONFIG_PATH='${configPath}'; node '${solverPath}' 2>&1 | Out-String; Write-Output "EXIT_CODE:$LASTEXITCODE"`,
          timeout + 30000,
        );
      } else {
        result = await this.exec(
          shell,
          `NODE_PATH=/usr/lib/node_modules node ${solverPath} 2>&1; echo "EXIT_CODE:$?"`,
          timeout + 30000,
        );
      }
    } catch (err) {
      // If exec throws, try to get output from the error
      result = err.message || err.toString();
      if (err.responseData && err.responseData.stdout) {
        result = err.responseData.stdout;
      }
    }

    const tokenMatch = result.match(/TOKEN:\s*(\S+)/);
    const success = result.includes('"success":true');
    const hasError = result.includes("ERROR:");

    if (hasError && !success) {
      const errorMatch = result.match(/ERROR:\s*(.+)/);
      throw new Error(
        `[captcha] ${errorMatch ? errorMatch[1] : "Unknown error"}\nOutput: ${result}`,
      );
    }

    return {
      success,
      message: success
        ? "Captcha solved successfully"
        : "Captcha solving failed",
      token: tokenMatch ? tokenMatch[1] : null,
      output: result,
    };
  }

  /**
   * Authenticate with TestDriver API
   * @returns {Promise<string>} Authentication token
   */
  async auth() {
    if (this.authenticated) {
      return;
    }

    const token = await this.apiClient.auth();
    this.authenticated = true;
    return token;
  }

  /**
   * Connect to a sandbox environment
   * @param {Object} options - Connection options
   * @param {string} options.sandboxId - Existing sandbox ID to reconnect to
   * @param {boolean} options.newSandbox - Force creation of a new sandbox
   * @param {string} options.ip - Direct IP address to connect to
   * @param {string} options.sandboxAmi - AMI to use for the sandbox
   * @param {string} options.sandboxInstance - Instance type for the sandbox
   * @param {string} options.e2bTemplateId - E2B template ID to use when creating the sandbox
   * @param {string} options.os - Operating system for the sandbox (windows or linux)
   * @param {boolean} options.reuseConnection - Reuse recent connection if available (default: true)
   * @returns {Promise<Object>} Sandbox instance details
   */
  async connect(connectOptions = {}) {
    if (this.connected) {
      throw new Error(
        "Already connected. Create a new TestDriver instance to connect again.",
      );
    }

    // Clean up screenshots folder for this test file before running.
    // Only clean once per directory per process to avoid concurrent tests
    // in the same file (--sequence.concurrent) from nuking each other's screenshots.
    if (this.testFile) {
      const testFileName = path.basename(
        this.testFile,
        path.extname(this.testFile),
      );
      const screenshotsDir = path.join(
        process.cwd(),
        ".testdriver",
        "screenshots",
        testFileName,
      );
      if (!_cleanedScreenshotDirs.has(screenshotsDir)) {
        _cleanedScreenshotDirs.add(screenshotsDir);
        if (fs.existsSync(screenshotsDir)) {
          fs.rmSync(screenshotsDir, { recursive: true, force: true });
        }
      }
    }

    // Log environment info immediately so it's visible even if auth fails
    this._logEnvironmentInfo();

    // Authenticate first if not already authenticated
    if (!this.authenticated) {
      await this.auth();
    }

    // Initialize debugger server before connecting to sandbox
    // This ensures the debuggerUrl is available for renderSandbox
    await this._initializeDebugger();

    // Map SDK connect options to agent buildEnv options
    // Use connectOptions.newSandbox if provided, otherwise fall back to this.newSandbox
    // Use connectOptions.headless if provided, otherwise fall back to this.headless
    const buildEnvOptions = {
      headless:
        connectOptions.headless !== undefined
          ? connectOptions.headless
          : this.headless,
      new:
        connectOptions.newSandbox !== undefined
          ? connectOptions.newSandbox
          : this.newSandbox,
      // Attach to `sandboxId` or throw — never silently substitute a fresh
      // sandbox. Off by default so the CLI keeps its forgiving
      // reconnect-or-create behavior; see buildEnv's `requireSandbox`.
      requireSandbox: connectOptions.requireSandbox === true,
    };

    // Set agent properties for buildEnv to use
    if (connectOptions.sandboxId) {
      this.agent.sandboxId = connectOptions.sandboxId;
    } else if (this.sandboxId) {
      // Constructor-provided sandboxId (explicit or loaded from .testdriver/last-sandbox)
      this.agent.sandboxId = this.sandboxId;
    }
    // Use IP from connectOptions if provided, otherwise fall back to constructor IP
    if (connectOptions.ip !== undefined) {
      this.agent.ip = connectOptions.ip;
    } else if (this.ip) {
      this.agent.ip = this.ip;
    }
    // Use instanceId from connectOptions if provided, otherwise fall back to constructor value
    // This allows the API to provision Ably credentials via SSM for direct connections
    if (connectOptions.instanceId !== undefined) {
      this.agent.instanceId = connectOptions.instanceId;
    } else if (this.instanceId) {
      this.agent.instanceId = this.instanceId;
    }
    // Use sandboxAmi from connectOptions if provided, otherwise fall back to constructor value
    if (connectOptions.sandboxAmi !== undefined) {
      this.agent.sandboxAmi = connectOptions.sandboxAmi;
    } else if (this.sandboxAmi) {
      this.agent.sandboxAmi = this.sandboxAmi;
    }
    // Use sandboxInstance from connectOptions if provided, otherwise fall back to constructor value
    if (connectOptions.sandboxInstance !== undefined) {
      this.agent.sandboxInstance = connectOptions.sandboxInstance;
    } else if (this.sandboxInstance) {
      this.agent.sandboxInstance = this.sandboxInstance;
    }
    // Use e2bTemplateId from connectOptions if provided, otherwise fall back to constructor value
    if (connectOptions.e2bTemplateId !== undefined) {
      this.agent.e2bTemplateId = connectOptions.e2bTemplateId;
    } else if (this.e2bTemplateId) {
      this.agent.e2bTemplateId = this.e2bTemplateId;
    }
    // Use os from connectOptions if provided, otherwise fall back to this.os
    if (connectOptions.os !== undefined) {
      this.agent.sandboxOs = connectOptions.os;
      this.os = connectOptions.os; // Update this.os to match
    } else {
      this.agent.sandboxOs = this.os;
    }
    // Use keepAlive from connectOptions if provided, otherwise fall back to constructor option
    if (connectOptions.keepAlive !== undefined) {
      this.agent.keepAlive = connectOptions.keepAlive;
    } else if (this.keepAlive !== undefined) {
      this.agent.keepAlive = this.keepAlive;
    }

    // Set redrawThreshold on agent's cliArgs.options
    this.agent.cliArgs.options.redrawThreshold = this.redrawThreshold;

    // Pass test file name to agent for debugger display
    if (this.testFile) {
      this.agent.testFile = this.testFile;
    }

    // Use the agent's buildEnv method which handles all the connection logic
    await this.agent.buildEnv(buildEnvOptions);

    // Get the instance from the agent
    this.instance = this.agent.instance;

    // Ensure this.os reflects the actual sandbox OS (important for vitest reporter)
    // After buildEnv, agent.sandboxOs should contain the correct OS value
    if (this.agent.sandboxOs) {
      this.os = this.agent.sandboxOs;
    }

    // Also ensure sandbox.os is set for consistency
    if (this.agent.sandbox && this.os) {
      this.agent.sandbox.os = this.os;
    }

    // Expose the agent's commands, parser, and commander
    this.commands = this.agent.commands;

    // Recreate commands with dashcam elapsed time support
    const { createCommands } = require("./agent/lib/commands.js");
    const commandsResult = createCommands(
      this.agent.emitter,
      this.agent.system,
      this.agent.sandbox,
      this.agent.config,
      this.agent.session,
      () => this.agent.sourceMapper?.currentFilePath || this.agent.thisFile,
      this.agent.cliArgs.options.redrawThreshold,
      () => this.getDashcamElapsedTime(), // Pass dashcam elapsed time function
    );
    this.commands = commandsResult.commands;
    this.agent.commands = commandsResult.commands;
    this.agent.redraw = commandsResult.redraw;

    // Command methods are already set up in constructor with lazy-await
    // They will use this.commands which is now populated

    this.connected = true;
    this.analytics.track("sdk.connect", {
      sandboxId: this.instance?.instanceId,
    });

    // Persist the active sandbox id so a later run with `reconnect: true`
    // can reattach without the caller having to thread the id through.
    const activeSandboxId =
      this.instance?.sandboxId || this.instance?.instanceId || null;
    if (activeSandboxId) {
      this.sandboxId = activeSandboxId;
      TestDriverSDK._writeLastSandbox({
        sandboxId: activeSandboxId,
        os: this.os,
        e2bTemplateId: this.e2bTemplateId || null,
        createdAt: Date.now(),
      });
    }

    return this.instance;
  }

  /**
   * Disconnect from the sandbox
   * Note: After disconnecting, you cannot reconnect with the same SDK instance.
   * Create a new TestDriver instance if you need to connect again.
   * @returns {Promise<void>}
   */
  async disconnect() {
    // Track disconnect event if we were connected
    if (this.connected && this.instance) {
      this.analytics.track("sdk.disconnect");
    }

    // Clean up redraw interval if active
    if (this.agent?.redraw?.cleanup) {
      try {
        this.agent.redraw.cleanup();
      } catch (err) {
        // Ignore cleanup errors
      }
    }



    // Always close the sandbox WebSocket connection to clean up resources
    // This ensures we don't leave orphaned connections even if connect() failed
    // Must be awaited so presence.leave() completes before we return —
    // otherwise the concurrency counter on the API stays stale.
    if (this.sandbox && typeof this.sandbox.close === "function") {
      await this.sandbox.close();
    }

    // Remove all event listeners on the emitter to release references
    if (this.emitter && typeof this.emitter.removeAllListeners === "function") {
      this.emitter.removeAllListeners();
    }

    this.connected = false;
    this.instance = null;
    this.commands = null;
  }

  /**
   * Get the current session ID
   * Used for tracking and associating dashcam recordings with test results
   * @returns {string|null} The session ID or null if not connected
   */
  getSessionId() {
    return this.session?.get() || null;
  }

  // ====================================
  // Element Finding API
  // ====================================

  /**
   * Find an element by description
   * Automatically locates the element and returns it
   *
   * @param {string} description - Description of the element to find
   * @param {number | Object} [options] - Cache options: number for threshold, or object with {cacheKey, cache: { thresholds: { screen, element } }}
   * @returns {Promise<Element> & ChainableElement} Element instance that has been located, with chainable methods
   *
   * @example
   * // Find and click immediately (chainable)
   * await client.find('the sign in button').click();
   *
   * @example
   * // Find and click (traditional)
   * const element = await client.find('the sign in button');
   * await element.click();
   *
   * @example
   * // Find with cache key to enable caching
   * const element = await client.find('login button', { cacheKey: 'my-test-run' });
   *
   * @example
   * // Find with custom cache threshold (legacy)
   * const element = await client.find('login button', 0.05);
   *
   * @example
   * // Poll until element is found
   * let element;
   * while (!element?.found()) {
   *   element = await client.find('login button');
   *   if (!element.found()) {
   *     await new Promise(resolve => setTimeout(resolve, 1000));
   *   }
   * }
   * await element.click();
   */
  find(description, options) {
    // Wrap in async IIFE to support lazy-await and promise tracking
    const findPromise = (async () => {
      // Lazy-await: wait for connection if still pending
      if (this.__connectionPromise) {
        await this.__connectionPromise;
      }

      // Warn if previous command may not have been awaited
      if (this._lastCommandName && !this._lastPromiseSettled) {
        console.warn(
          `⚠️  Warning: Previous ${this._lastCommandName}() may not have been awaited.\n` +
            `   Add "await" before the call: await testdriver.${this._lastCommandName}(...)\n` +
            `   Unawaited promises can cause race conditions and flaky tests.`,
        );
      }

      this._ensureConnected();

      // Get caller info for auto-screenshot naming
      const callerInfo = this.autoScreenshots ? getCallerInfo() : null;

      // Track this promise for unawaited detection
      this._lastCommandName = "find";
      this._lastPromiseSettled = false;

      // Take "before" screenshot if enabled
      if (this.autoScreenshots) {
        await this._saveAutoScreenshot("find", "before", callerInfo, description);
      }

      const element = new Element(
        description,
        this,
        this.system,
        this.commands,
      );
      const result = await element.find(null, options);

      // Take "after" screenshot if enabled
      if (this.autoScreenshots) {
        await this._saveAutoScreenshot("find", "after", callerInfo, description);
      }

      this._lastPromiseSettled = true;
      return result;
    })();

    // Create a chainable promise that allows direct method chaining
    // e.g., await testdriver.find("button").click()
    return createChainablePromise(findPromise);
  }

  /**
   * Find all elements matching a description
   * Automatically locates all matching elements and returns them as an array
   *
   * @param {string} description - Description of the elements to find
   * @param {number | Object} [options] - Cache options: number for threshold, or object with {cacheKey, cache: { thresholds: { screen } }}
   * @returns {Promise<Element[]>} Array of Element instances that have been located
   *
   * @example
   * // Find all buttons and click the first one
   * const buttons = await client.findAll('button');
   * if (buttons.length > 0) {
   *   await buttons[0].click();
   * }
   *
   * @example
   * // Find all list items with cache key to enable caching
   * const items = await client.findAll('list item', { cacheKey: 'my-test-run' });
   * for (const item of items) {
   *   console.log(`Found item at (${item.x}, ${item.y})`);
   * }
   */
  async findAll(description, options) {
    // Lazy-await: wait for connection if still pending
    if (this.__connectionPromise) {
      await this.__connectionPromise;
    }

    // Warn if previous command may not have been awaited
    if (this._lastCommandName && !this._lastPromiseSettled) {
      console.warn(
        `⚠️  Warning: Previous ${this._lastCommandName}() may not have been awaited.\n` +
          `   Add "await" before the call: await testdriver.${this._lastCommandName}(...)\n` +
          `   Unawaited promises can cause race conditions and flaky tests.`,
      );
    }

    this._ensureConnected();

    // Get caller info for auto-screenshot naming
    const callerInfo = this.autoScreenshots ? getCallerInfo() : null;

    // Track this promise for unawaited detection
    this._lastCommandName = "findAll";
    this._lastPromiseSettled = false;

    // Take "before" screenshot if enabled
    if (this.autoScreenshots) {
      await this._saveAutoScreenshot("findAll", "before", callerInfo, description);
    }

    // Capture absolute timestamp at the very start of the command
    // Frontend will calculate relative time using: timestamp - replay.clientStartDate
    const absoluteTimestamp = Date.now();
    const startTime = absoluteTimestamp;

    const { events } = require("./agent/events.js");

    try {
      // { imageKey } (fast S3-key path) or { image } (base64 fallback).
      const imagePayload = await this.system.captureScreenImage();

      // Handle options - can be a number (cacheThreshold) or object with cacheKey/cacheThreshold/cache
      let cacheKey = null;
      let cacheThreshold = null;
      let perCommandThresholds = null; // Per-command { screen } override (findAll has no element threshold)

      if (typeof options === "number") {
        // Legacy: options is just a number threshold
        cacheThreshold = options;
      } else if (typeof options === "object" && options !== null) {
        // New: options is an object with cacheKey and/or cacheThreshold
        cacheKey = options.cacheKey || null;
        cacheThreshold = options.cacheThreshold ?? null;
        // Per-command cache thresholds: { cache: { thresholds: { screen: 0.1 } } }
        if (typeof options.cache === "object" && options.cache?.thresholds) {
          perCommandThresholds = options.cache.thresholds;
        }
      }

      // Use default cacheKey from SDK constructor if not provided in findAll() options
      // BUT only if cache is not explicitly disabled via cache: false option
      if (
        !cacheKey &&
        this.options?.cacheKey &&
        !this._cacheExplicitlyDisabled
      ) {
        cacheKey = this.options.cacheKey;
      }

      // Determine threshold:
      // - If cache is explicitly disabled, don't use cache even with cacheKey
      // - If cacheKey is provided, enable cache with threshold
      // - If no cacheKey, disable cache
      let threshold;
      if (this._cacheExplicitlyDisabled) {
        // Cache explicitly disabled via cache: false option or TD_NO_CACHE env
        threshold = -1;
        cacheKey = null; // Clear any cacheKey to ensure cache is truly disabled
      } else if (cacheKey) {
        // cacheKey provided - enable cache with threshold (findAll only uses screen, no element)
        threshold = perCommandThresholds?.screen ?? cacheThreshold ?? this.cacheConfig?.thresholds?.find?.screen ?? 0.05;
      } else if (cacheThreshold !== null) {
        // Explicit threshold provided without cacheKey
        threshold = perCommandThresholds?.screen ?? cacheThreshold;
      } else {
        // No cacheKey, no explicit threshold - disable cache
        threshold = -1;
      }

      // Debug log threshold
      const debugMode =
        process.env.VERBOSE || process.env.TD_DEBUG;
      if (debugMode) {
        const autoGenMsg =
          this._autoGeneratedCacheKey && cacheKey === this.options.cacheKey
            ? " (auto-generated from file hash)"
            : "";
        this.emitter.emit(
          events.log.debug,
          `🔍 findAll() threshold: ${threshold} (cache ${threshold < 0 ? "DISABLED" : "ENABLED"}${cacheKey ? `, cacheKey: ${cacheKey}${autoGenMsg}` : ""})`,
        );
      }

      const response = await this.apiClient.req(
        "/api/v7.0.0/testdriver/find-all",
        {
          session: this.getSessionId(),
          element: description,
          ...imagePayload,
          threshold: threshold,
          cacheKey: cacheKey,
          os: this.os,
          resolution: this.resolution,
        },
      );

      const duration = Date.now() - startTime;

      if (response && response.elements && response.elements.length > 0) {
        // Single log at the end - found elements
        const formattedMessage = formatter.formatElementsFound(
          description,
          response.elements.length,
          {
            duration: duration,
            cacheHit: response.cached || false,
          },
        );
        this.emitter.emit(events.log.narration, formattedMessage, true);

        // Create Element instances for each found element
        const elements = response.elements.map((elementData) => {
          const element = new Element(
            description,
            this,
            this.system,
            this.commands,
          );

          // Set element as found with its coordinates
          element.coordinates = elementData.coordinates;
          element._found = true;
          element._response = this._sanitizeResponseForElement(
            response,
            elementData,
          );

          // Only store screenshot in DEBUG mode (and only when we have the
          // bytes locally — the fast imageKey path doesn't download them)
          const debugMode =
            process.env.VERBOSE || process.env.TD_DEBUG;
          if (debugMode && imagePayload.image) {
            element._screenshot = imagePayload.image;
          }

          return element;
        });

        // Track successful findAll interaction (fire-and-forget, don't block)
        const sessionId = this.getSessionId();
        const findAllCacheHit = response.cached || false;
        // Increment local interaction counters
        this._interactionStats.total++;
        this._interactionStats.byType.findAll = (this._interactionStats.byType.findAll || 0) + 1;
        if (findAllCacheHit) this._interactionStats.cached++;
        if (sessionId && this.apiClient) {
          this.apiClient
            .req("interaction/track", {
              type: "findAll",
              session: sessionId,
              prompt: description,
              timestamp: absoluteTimestamp, // Absolute epoch timestamp - frontend calculates relative using clientStartDate
              success: true,
              input: { count: elements.length },
              cacheHit: findAllCacheHit,
              selector: response.selector,
              selectorUsed: !!response.selector,
              screenshotUrl: response.screenshotKey ?? null,
            })
            .catch((err) => {
              console.warn("Failed to track findAll interaction:", err.message);
            });
        }

        // Log debug information when elements are found
        if (process.env.VERBOSE || process.env.TD_DEBUG) {
          this.emitter.emit(
            events.log.debug,
            `✓ Found ${elements.length} element(s): "${description}"`,
          );
          this.emitter.emit(
            events.log.debug,
            `  Cache: ${response.cached ? "HIT" : "MISS"}`,
          );
          this.emitter.emit(events.log.debug, `  Time: ${duration}ms`);
        }

        // Take "after" screenshot if enabled
        if (this.autoScreenshots) {
          await this._saveAutoScreenshot("findAll", "after", callerInfo, description);
        }

        this._lastPromiseSettled = true;
        return elements;
      } else {
        const duration = Date.now() - startTime;

        // Single log at the end - no elements found
        const formattedMessage = formatter.formatElementsFound(
          description,
          0,
          {
            duration: duration,
            cacheHit: response?.cached || false,
          },
        );
        this.emitter.emit(events.log.narration, formattedMessage, true);

        // No elements found - track interaction (fire-and-forget, don't block)
        const sessionId = this.getSessionId();
        const noResultCacheHit = response?.cached || false;
        // Increment local interaction counters
        this._interactionStats.total++;
        this._interactionStats.byType.findAll = (this._interactionStats.byType.findAll || 0) + 1;
        if (noResultCacheHit) this._interactionStats.cached++;
        if (sessionId && this.apiClient) {
          this.apiClient
            .req("interaction/track", {
              type: "findAll",
              session: sessionId,
              prompt: description,
              timestamp: absoluteTimestamp, // Absolute epoch timestamp - frontend calculates relative using clientStartDate
              success: false,
              error: "No elements found",
              input: { count: 0 },
              cacheHit: noResultCacheHit,
              selector: response?.selector,
              selectorUsed: !!response?.selector,
              screenshotUrl: response?.screenshotKey ?? null,
            })
            .catch((err) => {
              console.warn("Failed to track findAll interaction:", err.message);
            });
        }

        // Take "after" screenshot if enabled (no elements found)
        if (this.autoScreenshots) {
          await this._saveAutoScreenshot("findAll", "after", callerInfo, description);
        }

        // No elements found - return empty array
        this._lastPromiseSettled = true;
        return [];
      }
    } catch (error) {
      const duration = Date.now() - startTime;

      // A rejected or missing OpenRouter key isn't "zero elements matched" —
      // returning [] here would hide the only thing the user can act on.
      if (error.isConfigError) {
        this._lastPromiseSettled = true;
        this.emitter.emit(
          events.log.log,
          formatter.formatError("Cannot run findAll()", error),
        );
        throw error;
      }

      // Single log at the end - error
      const formattedMessage = formatter.formatElementsFound(
        description,
        0,
        {
          duration: duration,
        },
      );
      this.emitter.emit(events.log.narration, formattedMessage, true);

      // Track findAll error interaction (fire-and-forget, don't block)
      const sessionId = this.getSessionId();
      // Increment local interaction counters
      this._interactionStats.total++;
      this._interactionStats.byType.findAll = (this._interactionStats.byType.findAll || 0) + 1;
      if (sessionId && this.apiClient) {
        this.apiClient
          .req("interaction/track", {
            type: "findAll",
            session: sessionId,
            prompt: description,
            timestamp: absoluteTimestamp, // Absolute epoch timestamp - frontend calculates relative using clientStartDate
            success: false,
            error: error.message,
            input: { count: 0 },
          })
          .catch((err) => {
            console.warn("Failed to track findAll interaction:", err.message);
          });
      }

      // Take "error" screenshot if enabled
      if (this.autoScreenshots) {
        await this._saveAutoScreenshot("findAll", "error", callerInfo, description);
      }

      this._lastPromiseSettled = true;
      return [];
    }
  }

  /**
   * Sanitize response for individual element in findAll results
   * @private
   * @param {Object} response - Full API response
   * @param {Object} elementData - Individual element data
   * @returns {Object} Sanitized response for this element
   */
  _sanitizeResponseForElement(response, elementData) {
    const debugMode =
      process.env.VERBOSE || process.env.TD_DEBUG;

    // Combine global response data with element-specific data
    const sanitized = {
      coordinates: elementData.coordinates,
      cached: response.cached || false,
      elementType: response.elementType,
      extractedText: response.extractedText,
      confidence: elementData.confidence,
      similarity: elementData.similarity,
      boundingBox: elementData.boundingBox,
      width: elementData.width,
      height: elementData.height,
      text: elementData.text,
      label: elementData.label,
    };

    // Only keep large data in debug mode
    if (debugMode) {
      sanitized.croppedImage = elementData.croppedImage;
      sanitized.screenshot = response.screenshot;
    }

    return sanitized;
  }

  // ====================================
  // Command Methods Setup
  // ====================================

  /**
   * Dynamically set up command methods based on available commands
   * This creates camelCase methods that wrap the underlying command functions
   * When autoScreenshots is enabled, captures before/after screenshots for each command
   * @private
   */
  _setupCommandMethods() {
    // Mapping from internal command names to SDK method names
    const commandMapping = {
      "hover-text": "hoverText",
      "hover-image": "hoverImage",
      "match-image": "matchImage",
      type: "type",
      "press-keys": "pressKeys",
      click: "click",
      hover: "hover",
      scroll: "scroll",
      wait: "wait",
      "wait-for-text": "waitForText",
      "wait-for-image": "waitForImage",
      "scroll-until-text": "scrollUntilText",
      "scroll-until-image": "scrollUntilImage",
      "focus-application": "focusApplication",
      extract: "extract",
      assert: "assert",
      exec: "exec",
    };

    // Helper to extract a description from command args for screenshot naming
    const getDescriptionFromArgs = (methodName, args) => {
      if (!args || args.length === 0) return "";
      const firstArg = args[0];
      
      switch (methodName) {
        case "type":
          // For type, use the text being typed (truncated)
          return typeof firstArg === "string" ? firstArg.substring(0, 20) : "";
        case "pressKeys":
          // For pressKeys, show the keys
          return Array.isArray(firstArg) ? firstArg.join("+") : String(firstArg);
        case "click":
        case "hover":
          // For click/hover, try to get coordinates or prompt
          if (typeof firstArg === "object" && firstArg !== null) {
            return firstArg.prompt || `${firstArg.x},${firstArg.y}`;
          }
          return typeof firstArg === "number" ? `${firstArg},${args[1]}` : "";
        case "scroll":
          // For scroll, show direction
          return typeof firstArg === "string" ? firstArg : "down";
        case "waitForText":
        case "scrollUntilText":
          // For text-based commands, use the text
          if (typeof firstArg === "object" && firstArg !== null) {
            return firstArg.text || "";
          }
          return typeof firstArg === "string" ? firstArg : "";
        case "focusApplication":
          // For focus, use the app name
          return typeof firstArg === "string" ? firstArg : "";
        case "assert":
        case "extract":
          // For assert/extract, use the assertion/description
          return typeof firstArg === "string" ? firstArg.substring(0, 30) : "";
        case "exec":
          // For exec, show the language
          if (typeof firstArg === "object" && firstArg !== null) {
            return firstArg.language || "code";
          }
          return typeof firstArg === "string" ? firstArg : "code";
        default:
          return typeof firstArg === "string" ? firstArg.substring(0, 20) : "";
      }
    };

    // Create SDK methods that lazy-await connection then forward to this.commands
    for (const [commandName, methodName] of Object.entries(commandMapping)) {
      // Use closure to capture sdk reference instead of .bind(this)
      // This allows Error.captureStackTrace to correctly exclude the method from stack traces
      const sdk = this;
      const methodFn = async function (...args) {
        // Lazy-await: wait for connection if still pending
        if (sdk.__connectionPromise) {
          await sdk.__connectionPromise;
        }

        // Warn if previous command may not have been awaited
        if (sdk._lastCommandName && !sdk._lastPromiseSettled) {
          console.warn(
            `⚠️  Warning: Previous ${sdk._lastCommandName}() may not have been awaited.\n` +
              `   Add "await" before the call: await testdriver.${sdk._lastCommandName}(...)\n` +
              `   Unawaited promises can cause race conditions and flaky tests.`,
          );
        }

        sdk._ensureConnected();

        // Capture the call site for better error reporting AND for auto-screenshots
        const callSite = {};
        Error.captureStackTrace(callSite, methodFn);

        // Get caller info for auto-screenshot naming
        const callerInfo = sdk.autoScreenshots ? getCallerInfo() : null;
        const description = sdk.autoScreenshots ? getDescriptionFromArgs(methodName, args) : "";

        // Track this promise for unawaited detection
        sdk._lastCommandName = methodName;
        sdk._lastPromiseSettled = false;

        try {
          // Take "before" screenshot if enabled
          if (sdk.autoScreenshots) {
            await sdk._saveAutoScreenshot(methodName, "before", callerInfo, description);
          }

          let result;
          // Special handling for assert to inject SDK options (cacheKey, os, resolution, threshold)
          // similar to how find() handles these in the Element class
          // Note: assert does NOT use elementSimilarity (template matching not relevant for assertions)
          if (commandName === 'assert') {
            const assertion = args[0];
            const userOptions = args[1] || {};
            
            // Support per-command cache threshold override: { cache: { threshold: 0.05 } }
            const perCommandThreshold = typeof userOptions.cache === "object"
              ? userOptions.cache.threshold
              : undefined;
            
            // Merge SDK defaults with user options (user options take precedence)
            const mergedOptions = {
              cacheKey: userOptions.cacheKey ?? sdk.options.cacheKey,
              os: userOptions.os ?? sdk.os,
              resolution: userOptions.resolution ?? sdk.resolution,
              threshold: perCommandThreshold ?? userOptions.threshold ?? (sdk.cacheConfig?.thresholds?.assert ?? sdk.cacheThresholds?.assert ?? 0.05),
              ai: {
                ...sdk.aiConfig,
                ...(typeof userOptions.ai === "object" ? userOptions.ai : {}),
                top: {
                  ...sdk.aiConfig?.top,
                  ...(typeof userOptions.ai === "object" ? userOptions.ai?.top : {}),
                },
              },
            };
            
            // Note: commands.assert takes (assertion, options), shouldThrow is determined internally
            result = await sdk.commands[commandName](assertion, mergedOptions);
          } else {
            result = await sdk.commands[commandName](...args);
          }

          // Take "after" screenshot if enabled
          if (sdk.autoScreenshots) {
            await sdk._saveAutoScreenshot(methodName, "after", callerInfo, description);
          }

          sdk._lastPromiseSettled = true;
          return result;
        } catch (error) {
          // Take "error" screenshot if enabled (instead of "after")
          if (sdk.autoScreenshots) {
            await sdk._saveAutoScreenshot(methodName, "error", callerInfo, description);
          }

          sdk._lastPromiseSettled = true;
          // Ensure we have a proper Error object with a message
          let properError = error;
          if (!(error instanceof Error)) {
            const errorMessage =
              error?.message || error?.reason || JSON.stringify(error);
            properError = new Error(errorMessage);
            if (error?.code) properError.code = error.code;
            if (error?.fullError) properError.fullError = error.fullError;
          }

          // Replace the stack trace to point to the actual caller instead of SDK internals
          if (Error.captureStackTrace && callSite.stack) {
            const errorMessage = properError.stack?.split("\n")[0];
            const callerStack = callSite.stack?.split("\n").slice(1);
            properError.stack = errorMessage + "\n" + callerStack.join("\n");
          }
          throw properError;
        }
      };
      this[methodName] = methodFn;

      // Preserve the original function's name for better debugging
      Object.defineProperty(this[methodName], "name", {
        value: methodName,
        writable: false,
      });
    }
  }

  // ====================================
  // Helper Methods
  // ====================================

  /**
   * Capture a screenshot of the current screen and save it to .testdriver/screenshots
   * @param {string} [filename] - Custom filename (without .png extension)
   * @returns {Promise<string>} The file path where the screenshot was saved
   *
   * @example
   * // Capture a screenshot with auto-generated filename
   * const screenshotPath = await testdriver.screenshot();
   *
   * @example
   * // Capture with custom filename
   * const screenshotPath = await testdriver.screenshot("login-page");
   * // Saves to: .testdriver/screenshots/<test>/login-page.png
   */
  async screenshot(filename) {
    this._ensureConnected();

    const finalFilename = filename
      ? filename.endsWith(".png")
        ? filename
        : `${filename}.png`
      : `screenshot-${Date.now()}.png`;

    const base64Data = await this.system.captureScreenBase64(1, false, false);

    // Save to .testdriver/screenshots/<test-file-name> directory
    let screenshotsDir = path.join(process.cwd(), ".testdriver", "screenshots");
    if (this.testFile) {
      const testFileName = path.basename(
        this.testFile,
        path.extname(this.testFile),
      );
      screenshotsDir = path.join(screenshotsDir, testFileName);
    }
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }

    const filePath = path.join(screenshotsDir, finalFilename);

    // Remove data:image/png;base64, prefix if present
    const cleanBase64 = base64Data.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(cleanBase64, "base64");

    fs.writeFileSync(filePath, buffer);

    this.emitter.emit("log:info", `📸 Screenshot saved to: ${filePath}`);

    return filePath;
  }

  /**
   * Parse the current screen using OmniParser v2 to detect all UI elements
   * Returns structured data with element types, bounding boxes, and content
   * Requires enterprise or self-hosted plan.
   *
   * @returns {Promise<ParseResult>} Parsed screen elements
   *
   * @typedef {Object} ParseResult
   * @property {ParsedElement[]} elements - Array of detected UI elements
   * @property {string} annotatedImageUrl - URL of the annotated screenshot
   * @property {number} imageWidth - Width of the analyzed image
   * @property {number} imageHeight - Height of the analyzed image
   *
   * @typedef {Object} ParsedElement
   * @property {number} index - Element index
   * @property {string} type - Element type (e.g. "text", "icon", "button")
   * @property {string} content - Text content or description
   * @property {string} interactivity - Interactivity level (e.g. "clickable", "non-interactive")
   * @property {Object} bbox - Bounding box in pixel coordinates
   * @property {number} bbox.x0 - Left edge X coordinate
   * @property {number} bbox.y0 - Top edge Y coordinate
   * @property {number} bbox.x1 - Right edge X coordinate
   * @property {number} bbox.y1 - Bottom edge Y coordinate
   * @property {Object} boundingBox - Bounding box as {left, top, width, height}
   * @property {number} boundingBox.left - Left position
   * @property {number} boundingBox.top - Top position
   * @property {number} boundingBox.width - Element width
   * @property {number} boundingBox.height - Element height
   *
   * @example
   * // Get all elements on screen
   * const result = await testdriver.parse();
   * console.log(`Found ${result.elements.length} elements`);
   *
   * @example
   * // Find clickable elements
   * const result = await testdriver.parse();
   * const clickable = result.elements.filter(e => e.interactivity === 'clickable');
   *
   * @example
   * // Find text content
   * const result = await testdriver.parse();
   * const textElements = result.elements.filter(e => e.type === 'text');
   * textElements.forEach(e => console.log(e.content));
   */
  async parse() {
    this._ensureConnected();

    const { events } = require("./agent/events.js");
    this.emitter.emit(events.log.log, "🔍 Running OmniParser screen analysis...");

    const response = await this.apiClient.req("parse", {
      session: this.getSessionId(),
      ...(await this.system.captureScreenImage()),
    });

    if (response.error) {
      throw new Error(response.error);
    }

    this.emitter.emit(
      events.log.log,
      `✅ Parse complete: ${response.elements?.length || 0} elements detected`,
    );

    // Output elements as a formatted table
    if (response.elements && response.elements.length > 0) {
      const tableOutput = formatter.formatParseElements(response.elements);
      this.emitter.emit(events.log.log, tableOutput);
    }

    return response;
  }

  /**
   * Save an automatic screenshot with descriptive naming
   * Used internally when autoScreenshots is enabled
   * @private
   * @param {string} actionName - Name of the action (click, type, hover, etc.)
   * @param {string} phase - 'before' or 'after'
   * @param {Object} callerInfo - Caller information from getCallerInfo()
   * @param {string} [description] - Optional description of the action target
   * @returns {Promise<string|null>} The file path where the screenshot was saved, or null if failed
   */
  async _saveAutoScreenshot(actionName, phase, callerInfo, description = "") {
    if (!this.autoScreenshots || !this.connected) {
      return null;
    }

    try {
      // Increment sequence for unique ordering
      this._screenshotSequence++;
      const seq = String(this._screenshotSequence).padStart(3, "0");

      // Extract line number info
      const lineInfo = callerInfo.line ? `L${callerInfo.line}` : "L???";

      // Sanitize description for filename (remove special chars, limit length)
      const sanitizedDesc = description
        .replace(/[^a-zA-Z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .substring(0, 30)
        .toLowerCase();

      // Build filename: 001-click-before-L42-submit-button.png
      const descPart = sanitizedDesc ? `-${sanitizedDesc}` : "";
      const filename = `${seq}-${actionName}-${phase}-${lineInfo}${descPart}.png`;

      const base64Data = await this.system.captureScreenBase64(1, false, false);

      // Save to .testdriver/screenshots/<test-file-name> directory
      let screenshotsDir = path.join(process.cwd(), ".testdriver", "screenshots");
      if (this.testFile) {
        const testFileName = path.basename(
          this.testFile,
          path.extname(this.testFile),
        );
        screenshotsDir = path.join(screenshotsDir, testFileName);
      }
      if (!fs.existsSync(screenshotsDir)) {
        fs.mkdirSync(screenshotsDir, { recursive: true });
      }

      const filePath = path.join(screenshotsDir, filename);

      // Remove data:image/png;base64, prefix if present
      const cleanBase64 = base64Data.replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(cleanBase64, "base64");

      fs.writeFileSync(filePath, buffer);

      // Debug log in verbose mode
      const debugMode = process.env.VERBOSE || process.env.TD_DEBUG;
      if (debugMode) {
        this.emitter.emit("log:debug", `📸 Auto-screenshot: ${filename}`);
      }

      return filePath;
    } catch (error) {
      // Don't fail the command if screenshot fails
      const debugMode = process.env.VERBOSE || process.env.TD_DEBUG;
      if (debugMode) {
        this.emitter.emit("log:debug", `Failed to save auto-screenshot: ${error.message}`);
      }
      return null;
    }
  }

  /**
   * Ensure the SDK is connected before running commands
   * @private
   */
  _ensureConnected() {
    if (!this.connected) {
      throw new Error("SDK is not connected. Call connect() first.");
    }
  }

  /**
   * Get the current sandbox instance details
   * @returns {Object|null} Sandbox instance
   */
  getInstance() {
    return this.instance;
  }

  /**
   * Enable or disable logging output
   * @param {boolean} enabled - Whether to enable logging
   */
  setLogging(enabled) {
    this.loggingEnabled = enabled;
    if (enabled && !this._loggingSetup) {
      this._setupLogging();
    }
  }

  /**
   * Get the event emitter for custom event handling
   * @returns {EventEmitter2} Event emitter
   */
  getEmitter() {
    return this.emitter;
  }

  /**
   * Set test context for enhanced logging (integrates with Vitest)
   * @param {Object} context - Test context with file, test name, start time
   * @param {string} [context.file] - Current test file name
   * @param {string} [context.test] - Current test name
   * @param {number} [context.startTime] - Test start timestamp
   */
  setTestContext(context) {
    formatter.setTestContext(context);
  }

  /**
   * Set up logging for the SDK
   * @private
   */
  /**
   * Log environment info (version, API URL, git commit) after connect.
   * Fires asynchronously so it never blocks the test.
   * Suppressed when the API reports the "stable" channel.
   * @private
   */
  _logEnvironmentInfo() {
    const apiRoot = this.config?.TD_API_ROOT || 'unknown';
    const apiKey = this.config?.TD_API_KEY || '';
    const maskedKey = apiKey.length > 4 ? '***' + apiKey.slice(-4) : '(not set)';
    const channelConfig = require('./lib/resolve-channel.js');
    const env = process.env.TD_CHANNEL || process.env.TD_ENV || channelConfig.active || 'unknown';
    const os = this.os || this.agent?.options?.os || process.env.TD_OS || 'linux';
    const sdkVersion = require('./package.json').version;

    // Always print local config immediately
    const localLines = [
      '',
      `  ┌─ TestDriver SDK v${sdkVersion}`,
      `  │ Environment: ${env}`,
      `  │ API: ${apiRoot}`,
      `  │ Key: ${maskedKey}`,
      `  │ OS: ${os}`,
      `  └─`,
      '',
    ];
    console.log(localLines.join('\n'));

    // Fetch API version info asynchronously (non-blocking, best-effort)
    const http = apiRoot.startsWith('https') ? require('https') : require('http');
    const url = apiRoot + '/api/entrance/version';
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const info = JSON.parse(data);
          // Persist API version for test result metadata
          this._apiVersion = info.version || null;
          const commit = info.commit || 'unknown';
          const shortCommit = commit.substring(0, 7);
          const commitUrl = commit !== 'unknown'
            ? `https://github.com/testdriverai/mono/commit/${commit}`
            : null;
          const lines = [
            `  ┌─ API Server`,
            `  │ Channel: ${info.channel || 'unknown'} v${info.version || '?'}`,
            commitUrl
              ? `  │ Commit: ${shortCommit} → ${commitUrl}`
              : `  │ Commit: ${shortCommit}`,
            `  └─`,
            '',
          ];
          console.log(lines.join('\n'));
        } catch (_) { /* ignore parse errors */ }
      });
    });
    req.on('error', () => { /* ignore network errors */ });
  }

  _setupLogging() {
    // Track the last fatal error message to throw on exit
    let lastFatalError = null;
    const debugMode =
      process.env.VERBOSE || process.env.TD_DEBUG;

    // Set up markdown logger
    createMarkdownLogger(this.emitter);

    // Set up basic event logging
    // Note: We only console.log here - the console spy in vitest/hooks.mjs
    // handles forwarding to the local log buffer.
    this.emitter.on("log:**", (message) => {
      const event = this.emitter.event;

      if (event.includes("markdown")) {
        return;
      }

      if (event === events.log.debug && !debugMode) return;
      if (this.loggingEnabled && message) {
        const prefixedMessage = this.testContext
          ? `[${this.testContext}] ${message}`
          : message;
        console.log(prefixedMessage);
      }

      // Buffer structured SDK log for later upload
      if (message) {
        const level = event === events.log.warn ? "warn"
          : event === events.log.debug ? "debug"
          : "info";
        this._logBuffer.push({
          time: Date.now(),
          line: String(message),
          level,
          source: "sdk",
          event,
          logFile: "sdk",
        });
      }
    });

    this.emitter.on("error:**", (data) => {
      if (this.loggingEnabled) {
        const event = this.emitter.event;
        console.error(event, ":", data);

        // Capture fatal errors
        if (event === events.error.fatal) {
          lastFatalError = data;
        }
      }

      // Buffer error events for later upload
      this._logBuffer.push({
        time: Date.now(),
        line: `${this.emitter.event}: ${data}`,
        level: "error",
        source: "sdk",
        event: this.emitter.event,
        logFile: "sdk",
      });
    });

    this.emitter.on("status", (message) => {
      if (this.loggingEnabled) {
        console.log(`- ${message}`);
      }

      // Buffer status events
      if (message) {
        this._logBuffer.push({
          time: Date.now(),
          line: `- ${message}`,
          level: "info",
          source: "sdk",
          event: "status",
          logFile: "sdk",
        });
      }
    });

    // Handle exit events - throw error with meaningful message instead of calling process.exit
    // This allows test frameworks like Vitest to properly catch and display the error
    this.emitter.on(events.exit, (exitCode) => {
      if (exitCode !== 0) {
        // Create an error with the fatal error message if available
        const errorMessage = lastFatalError || "TestDriver fatal error";
        const error = new Error(errorMessage);
        error.name = "TestDriverFatalError";
        error.exitCode = exitCode;
        throw error;
      }
    });

    // Handle show window events for sandbox visualization
    this.emitter.on("show-window", async (url) => {
      if (this.loggingEnabled) {
        console.log("");
        console.log("🔗 Live test execution:");
        console.log(url);
        if (!this.config.CI) {
          await this._openBrowser(url);
        }
      }
    });
  }

  /**
   * Open URL in default browser
   * @private
   * @param {string} url - URL to open
   */
  async _openBrowser(url) {
    try {
      // Use dynamic import for the 'open' package (ES module)
      const { default: open } = await import("open");

      // Open the browser
      await open(url, {
        wait: false,
      });
    } catch (error) {
      const { events } = require("./agent/events.js");
      this.emitter.emit(
        events.log.log,
        `Failed to open browser automatically: ${error.message}`,
      );
      this.emitter.emit(events.log.log, `Please manually open: ${url}`);
    }
  }

  /**
   * Initialize debugger server
   * @private
   */
  async _initializeDebugger() {
    // Debugger UI is now hosted on the web app (console.testdriver.ai/debugger/)
    // No local debugger server needed — the agent builds the URL at render time.
  }

  // ====================================
  // Test Recording Methods
  // ====================================

  /**
   * Create a new test run to track test execution
   *
   * @param {Object} options - Test run configuration
   * @param {string} options.runId - Unique identifier for this test run
   * @param {string} options.suiteName - Name of the test suite
   * @param {string} [options.platform] - Platform (windows/mac/linux)
   * @param {string} [options.sandboxId] - Sandbox ID (auto-detected from session if not provided)
   * @param {Object} [options.ci] - CI/CD metadata
   * @param {Object} [options.git] - Git metadata
   * @param {Object} [options.env] - Environment metadata
   * @returns {Promise<Object>} Created test run
   *
   * @example
   * const testRun = await client.createTestRun({
   *   runId: 'unique-run-id',
   *   suiteName: 'My Test Suite',
   *   platform: 'windows',
   *   git: {
   *     repo: 'myorg/myrepo',
   *     branch: 'main',
   *     commit: 'abc123'
   *   }
   * });
   */
  async createTestRun(options) {
    this._ensureConnected();

    const { createSDK } = require("./agent/lib/sdk.js");
    const sdk = createSDK(
      this.emitter,
      this.config,
      this.agent.sessionInstance,
    );
    await sdk.auth();

    const platform = options.platform || this.config.TD_PLATFORM || "linux";

    // Auto-detect sandbox ID from the active sandbox if not provided
    // For E2B (Linux), the instance has sandboxId; for AWS (Windows), it has instanceId
    const sandboxId =
      options.sandboxId ||
      this.instance?.sandboxId ||
      this.instance?.instanceId ||
      this.agent?.sandboxId ||
      null;

    // Get or create session ID using the agent's newSession method
    let sessionId = this.agent?.sessionInstance?.get() || null;

    const data = {
      runId: options.runId,
      suiteName: options.suiteName,
      platform,
      sandboxId: sandboxId,
      sessionId: sessionId,
      // CI/CD
      ciProvider: options.ci?.provider,
      ciRunId: options.ci?.runId,
      ciJobId: options.ci?.jobId,
      ciUrl: options.ci?.url,
      // Git
      repo: options.git?.repo,
      branch: options.git?.branch,
      commit: options.git?.commit,
      commitMessage: options.git?.commitMessage,
      author: options.git?.author,
      // Environment
      nodeVersion: options.env?.nodeVersion || process.version,
      testDriverVersion:
        options.env?.testDriverVersion || require("./package.json").version,
      vitestVersion: options.env?.vitestVersion,
      environment: options.env?.additional,
    };

    const result = await sdk.req("/api/v1/testdriver/test-run-create", data);
    return result.data;
  }

  /**
   * Complete a test run and update final statistics
   *
   * @param {Object} options - Test run completion data
   * @param {string} options.runId - Test run ID
   * @param {string} options.status - Final status (passed/failed/cancelled)
   * @param {number} [options.totalTests] - Total number of tests
   * @param {number} [options.passedTests] - Number of passed tests
   * @param {number} [options.failedTests] - Number of failed tests
   * @param {number} [options.skippedTests] - Number of skipped tests
   * @returns {Promise<Object>} Updated test run
   *
   * @example
   * await client.completeTestRun({
   *   runId: 'unique-run-id',
   *   status: 'passed',
   *   totalTests: 10,
   *   passedTests: 10,
   *   failedTests: 0
   * });
   */
  async completeTestRun(options) {
    this._ensureConnected();

    const { createSDK } = require("./agent/lib/sdk.js");
    const sdk = createSDK(
      this.emitter,
      this.config,
      this.agent.sessionInstance,
    );
    await sdk.auth();

    const result = await sdk.req(
      "/api/v1/testdriver/test-run-complete",
      options,
    );
    return result.data;
  }

  /**
   * Record a test case result
   *
   * @param {Object} options - Test case data
   * @param {string} options.runId - Test run ID
   * @param {string} options.testName - Name of the test
   * @param {string} options.testFile - Path to test file
   * @param {string} options.status - Test status (passed/failed/skipped/pending)
   * @param {string} [options.suiteName] - Test suite/describe block name
   * @param {number} [options.duration] - Test duration in ms
   * @param {string} [options.errorMessage] - Error message if failed
   * @param {string} [options.errorStack] - Error stack trace if failed
   * @param {string} [options.replayUrl] - Dashcam replay URL
   * @param {number} [options.replayStartTime] - Start time in replay
   * @param {number} [options.replayEndTime] - End time in replay
   * @returns {Promise<Object>} Created/updated test case
   *
   * @example
   * await client.recordTestCase({
   *   runId: 'unique-run-id',
   *   testName: 'should login successfully',
   *   testFile: 'tests/login.test.js',
   *   status: 'passed',
   *   duration: 1500,
   *   replayUrl: 'https://app.dashcam.io/replay/abc123'
   * });
   */
  async recordTestCase(options) {
    this._ensureConnected();

    const { createSDK } = require("./agent/lib/sdk.js");
    const sdk = createSDK(
      this.emitter,
      this.config,
      this.agent.sessionInstance,
    );
    await sdk.auth();

    const result = await sdk.req(
      "/api/v1/testdriver/test-case-create",
      options,
    );
    return result.data;
  }

  // ====================================
  // AI Methods (Exploratory Loop)
  // ====================================

  /**
   * Execute a natural language task using AI
   * This is the SDK equivalent of the CLI's exploratory loop
   *
   * @param {string} task - Natural language description of what to do
   * @param {Object} [options] - Execution options
   * @param {number} [options.tries=7] - Maximum number of check/retry attempts before giving up
   * @returns {Promise<ActResult>} Result object with success status and details
   * @throws {AIError} When the task fails after all tries are exhausted
   *
   * @typedef {Object} ActResult
   * @property {boolean} success - Whether the task completed successfully
   * @property {string} task - The original task that was executed
   * @property {number} tries - Number of check attempts made
   * @property {number} maxTries - Maximum tries that were allowed
   * @property {number} duration - Total execution time in milliseconds
   * @property {string} [response] - AI's final response if available
   *
   * @example
   * // Simple execution
   * const result = await client.act('Click the submit button');
   * console.log(result.success); // true
   *
   * @example
   * // With custom retry limit
   * const result = await client.act('Fill out the contact form', { tries: 10 });
   * console.log(`Completed in ${result.tries} tries`);
   *
   * @example
   * // Handle failures
   * try {
   *   await client.act('Complete the checkout process', { tries: 3 });
   * } catch (error) {
   *   console.log(`Failed after ${error.tries} tries: ${error.message}`);
   * }
   */
  async act(task, options = {}) {
    this._ensureConnected();

    const { tries = 7 } = options;

    this.analytics.track("sdk.act", { task, tries });

    const { events } = require("./agent/events.js");
    const startTime = Date.now();

    // Store original checkLimit and set custom one if provided
    const originalCheckLimit = this.agent.checkLimit;
    this.agent.checkLimit = tries;

    // Reset check count for this act() call
    const originalCheckCount = this.agent.checkCount;
    this.agent.checkCount = 0;

    // Enable soft assert mode so check-phase assertions don't throw
    const originalSoftAssertMode = this.agent.softAssertMode;
    this.agent.softAssertMode = true;

    // Emit scoped start marker for ai()
    this.emitter.emit(events.log.log, formatter.formatAIStart(task));

    try {
      // Use the agent's exploratoryLoop method directly
      const response = await this.agent.exploratoryLoop(
        task,
        false,
        true,
        false,
      );

      const duration = Date.now() - startTime;
      const triesUsed = this.agent.checkCount;

      this.emitter.emit(
        events.log.log,
        formatter.formatAIComplete(duration, true),
      );

      // Restore original state
      this.agent.checkLimit = originalCheckLimit;
      this.agent.checkCount = originalCheckCount;
      this.agent.softAssertMode = originalSoftAssertMode;

      return {
        success: true,
        task,
        tries: triesUsed,
        maxTries: tries,
        duration,
        response: response || undefined,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const triesUsed = this.agent.checkCount;

      this.emitter.emit(
        events.log.log,
        formatter.formatAIComplete(duration, false, error.message),
      );

      // Restore original state
      this.agent.checkLimit = originalCheckLimit;
      this.agent.checkCount = originalCheckCount;
      this.agent.softAssertMode = originalSoftAssertMode;

      // Create an enhanced error with additional context using AIError class
      throw new AIError(`AI failed: ${error.message}`, {
        task,
        tries: triesUsed,
        maxTries: tries,
        duration,
        cause: error,
      });
    }
  }

  /**
   * @deprecated Use act() instead
   * Execute a natural language task using AI
   *
   * @param {string} task - Natural language description of what to do
   * @param {Object} [options] - Execution options
   * @param {number} [options.tries=7] - Maximum number of check/retry attempts
   * @returns {Promise<ActResult>} Result object with success status and details
   */
  async ai(task, options) {
    return await this.act(task, options);
  }

  /**
   * Get buffered logs as a JSONL string for upload.
   * Each line is a JSON object with { time, line, level, source, event }.
   * @returns {string} JSONL-formatted log data
   */
  getLogs() {
    if (this._logBuffer.length === 0) return "";
    const startTime = this._logBuffer[0].time;
    return this._logBuffer
      .map((entry, index) => {
        const obj = { ...entry, time: entry.time - startTime };
        if (index === 0) obj.epoch = startTime; // absolute epoch for video alignment
        return JSON.stringify(obj);
      })
      .join("\n");
  }

  /**
   * Clear the internal log buffer.
   */
  clearLogs() {
    this._logBuffer = [];
  }

  /**
   * Return info about the most recently provisioned sandbox (from this process
   * or persisted from a previous run via .testdriver/last-sandbox).
   * @returns {{ sandboxId: string, os?: string, e2bTemplateId?: string|null, createdAt?: number } | null}
   */
  getLastSandboxId() {
    if (this.sandboxId) {
      return {
        sandboxId: this.sandboxId,
        os: this.os,
        e2bTemplateId: this.e2bTemplateId || null,
      };
    }
    return TestDriverSDK._readLastSandbox();
  }

  /** @private */
  static _lastSandboxPath() {
    return path.join(process.cwd(), ".testdriver", "last-sandbox");
  }

  /** @private */
  static _readLastSandbox() {
    try {
      const p = TestDriverSDK._lastSandboxPath();
      if (!fs.existsSync(p)) return null;
      const raw = fs.readFileSync(p, "utf8");
      const data = JSON.parse(raw);
      if (!data || !data.sandboxId) return null;
      return data;
    } catch (_) {
      return null;
    }
  }

  /** @private */
  static _writeLastSandbox(data) {
    try {
      const p = TestDriverSDK._lastSandboxPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(data, null, 2));
    } catch (_) {
      // Best-effort — don't fail the test if we can't persist.
    }
  }
}

// Expose SDK version as a static property for use by vitest hooks/plugins
TestDriverSDK.version = require("./package.json").version;

module.exports = TestDriverSDK;
module.exports.Element = Element;
module.exports.ElementNotFoundError = ElementNotFoundError;
module.exports.AIError = AIError;
