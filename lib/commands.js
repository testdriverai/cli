// the actual commands to interact with the system
const sdk = require("./sdk");
const vm = require("vm");
const theme = require("./theme");
const server = require("./ipc");
const {
  captureScreenBase64,
  captureScreenPNG,
  platform,
  activeWin,
} = require("./system");

const fs = require("fs").promises; // Using the promises version for async operations
const { findTemplateImage } = require("./subimage/index");
const { cwd } = require("node:process");
const path = require("path");
const Jimp = require("jimp");
const os = require("os");
const cliProgress = require("cli-progress");
const redraw = require("./redraw");
const sandbox = require("./sandbox.js");

const { logger, prettyMarkdown } = require("./logger");
const { emitter, events } = require("./events.js");

const niceSeconds = (ms) => {
  return Math.round(ms / 1000);
};
const delay = (t) => new Promise((resolve) => setTimeout(resolve, t));
class AiError extends Error {
  constructor(message, fatal = false, attatchScreenshot = true) {
    super(message);
    this.fatal = fatal;
    this.attachScreenshot = attatchScreenshot;
  }
}

const findImageOnScreen = async (relativePath, haystack, restrictToWindow) => {
  // move the file from filePath to `testdriver/screenshots`
  let rootpath = path.join(cwd(), `testdriver`, `screenshots`, platform());
  // add .png to relative path if not already there
  if (!relativePath.endsWith(".png")) {
    relativePath = relativePath + ".png";
  }

  let needle = path.join(rootpath, relativePath);

  // check if the file exists
  if (await !fs.access(needle)) {
    throw new AiError(`Image does not exist or do not have access: ${needle}`);
  }

  const bar1 = new cliProgress.SingleBar(
    {},
    cliProgress.Presets.shades_classic,
  );

  let thresholds = [0.9, 0.8, 0.7];

  let scaleFactors = [1, 0.5, 2, 0.75, 1.25, 1.5];

  let result = null;
  let highestThreshold = 0;

  let totalOperations = thresholds.length * scaleFactors.length;
  bar1.start(totalOperations, 0);

  for (let scaleFactor of scaleFactors) {
    let needleSize = 1 / scaleFactor;

    const scaledNeedle = await Jimp.read(path.join(needle));
    scaledNeedle.scale(needleSize);

    const haystackImage = await Jimp.read(haystack);

    if (
      scaledNeedle.bitmap.width > haystackImage.bitmap.width ||
      scaledNeedle.bitmap.height > haystackImage.bitmap.height
    ) {
      // Needle is larger than haystack, skip this scale factor
      continue;
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "scaledNeedle_"));
    const scaledNeedlePath = path.join(
      tempDir,
      `scaledNeedle_${needleSize}.png`,
    );
    await scaledNeedle.writeAsync(scaledNeedlePath);

    for (let threshold of thresholds) {
      if (threshold >= highestThreshold) {
        let results = await findTemplateImage(
          haystack,
          scaledNeedlePath,
          threshold,
        );

        // throw away any results that are not within the active window
        let activeWindow = await activeWin();

        // filter out text that is not in the active window
        if (restrictToWindow) {
          results = results.filter((el) => {
            return (
              el.centerX > activeWindow.bounds.x &&
              el.centerX < activeWindow.bounds.x + activeWindow.bounds.width &&
              el.centerY > activeWindow.bounds.y &&
              el.centerY < activeWindow.bounds.y + activeWindow.bounds.height
            );
          });
        }

        if (results.length) {
          result = { ...results[0], threshold, scaleFactor, needleSize };
          highestThreshold = threshold;
          break;
        }
      }

      bar1.increment();
    }
  }

  bar1.stop();

  return result;
};

const assert = async (assertion, shouldThrow = false, async = false) => {
  if (async) {
    shouldThrow = true;
  }

  const handleAssertResponse = (response) => {
    prettyMarkdown(response);

    if (response.indexOf("The task passed") > -1) {
      return true;
    } else {
      if (shouldThrow) {
        throw new AiError(`AI Assertion failed`, true);
      } else {
        return false;
      }
    }
  };

  // take a screenshot
  logger.info("");
  logger.info(theme.dim("thinking..."), true);
  server.broadcast("status", `thinking...`);
  logger.info("");

  if (async) {
    await sdk
      .req("assert", {
        expect: assertion,
        image: await captureScreenBase64(),
      })
      .then((response) => {
        return handleAssertResponse(response.data);
      });

    return true;
  } else {
    let response = await sdk.req("assert", {
      expect: assertion,
      image: await captureScreenBase64(),
    });
    return handleAssertResponse(response.data);
  }
};
const scroll = async (direction = "down", amount = 300, method = "mouse") => {
  await redraw.start();

  amount = parseInt(amount, 10);

  // if direction is down, amount should be negative
  if (direction === "down") {
    amount = -Math.abs(amount);
  } else if (direction === "up") {
    amount = Math.abs(amount);
  }

  const before = await captureScreenBase64();
  switch (direction) {
    case "up":
      if (method === "mouse") {
        await sandbox.send({ type: "scroll", amount, direction });
      } else {
        await sandbox.send({ type: "press", keys: ["pageup"] });
      }
      await redraw.wait(2500);
      break;
    case "down":
      if (method === "mouse") {
        await sandbox.send({ type: "scroll", amount, direction });
      } else {
        await sandbox.send({ type: "press", keys: ["pagedown"] });
      }
      await redraw.wait(2500);
      break;
    case "left":
      console.error("Not Supported");
      break;
    case "right":
      console.error("Not Supported");
      break;
    default:
      throw new AiError("Direction not found");
  }
  const after = await captureScreenBase64();

  if (before === after) {
    logger.warn(
      "Attempted to scroll, but the screen did not change.  You may need to click a non-interactive element to focus the scrollable area first.",
    );
  }
};

// perform a mouse click
// click, right-click, double-click, hover
const click = async (x, y, action = "click") => {
  emitter.emit(events.interactive, true);

  await redraw.start();

  let button = "left";
  let double = false;

  if (action === "right-click" && platform !== "darwin") {
    button = "right";
  }
  if (action === "double-click") {
    double = true;
  }

  logger.debug(
    theme.dim(`${action} ${button} clicking at ${x}, ${y}...`),
    true,
  );

  x = parseInt(x);
  y = parseInt(y);

  await sandbox.send({ type: "moveMouse", x, y });

  emitter.emit(events.mouseMove, { x, y });

  await delay(2500); // wait for the mouse to move

  if (action !== "hover") {
    if (action === "click" || action === "left-click") {
      await sandbox.send({ type: "leftClick" });
    } else if (action === "right-click") {
      await sandbox.send({ type: "rightClick" });
    } else if (action === "middle-click") {
      await sandbox.send({ type: "middleClick" });
    } else if (action === "double-click") {
      await sandbox.send({ type: "doubleClick" });
    } else if (action === "drag-start") {
      await sandbox.send({ type: "mousePress", button: "left" });
    } else if (action === "drag-end") {
      await sandbox.send({ type: "mouseRelease", button: "left" });
    }

    emitter.emit(events.mouseClick, { x, y, button, click, double });
  }

  await redraw.wait(5000);

  emitter.emit(events.interactive, false);

  return;
};

const hover = async (x, y) => {
  await redraw.start();

  x = parseInt(x);
  y = parseInt(y);

  await sandbox.send({ type: "moveMouse", x, y });

  await redraw.wait(2500);

  return;
};

let commands = {
  scroll: scroll,
  click: click,
  hover: hover,
  // method, levenshein, dice, or combined
  // leven = this is turbo, all around good for text similarity
  // dice = this is good for short strings, but not as good for long strings
  // turbo (default) = turbo of both, with a 2x preference for levenshtein
  "hover-text": async (
    text,
    description = null,
    action = "click",
    method = "turbo",
  ) => {
    text = text ? text.toString() : null;

    // wait for the text to appear on screen
    await commands["wait-for-text"](text, 5000);

    description = description ? description.toString() : null;

    logger.info("");
    logger.info(theme.dim("thinking..."), true);
    logger.info("");

    // const mdStream = createMarkdownStreamLogger();
    let response = await sdk.req(
      "hover/text",
      {
        needle: text,
        method,
        image: await captureScreenBase64(),
        intent: action,
        description,
        displayMultiple: 1,
      },
      (chunk) => {
        if (chunk.type === "data" && chunk.data) {
          // mdStream.log(chunk.data);
        } else if (chunk.type === "closeMatches") {
          emitter.emit(events.matches.show, chunk.data);
        }
      },
    );
    // mdStream.end();

    if (!response.data) {
      throw new AiError("No text on screen matches description");
    } else {
      return response.data;
    }
  },
  // uses our api to find all images on screen
  "hover-image": async (description, action = "click") => {
    // take a screenshot
    logger.info("");
    logger.info(theme.dim("thinking..."), true);
    logger.info("");

    // const mdStream = createMarkdownStreamLogger();
    let response = await sdk.req(
      "hover/image",
      {
        needle: description,
        image: await captureScreenBase64(),
        intent: action,
        displayMultiple: 1,
      },
      (chunk) => {
        if (chunk.type === "data") {
          // mdStream.log(chunk.data);
        } else if (chunk.type === "closeMatches") {
          emitter.emit(events.matches.show, chunk.data);
        }
      },
    );
    // mdStream.end();

    if (!response?.data) {
      throw new AiError("No image or icon on screen matches description");
    } else {
      return response.data;
    }
  },
  "match-image": async (relativePath, action = "click") => {
    let image = await captureScreenPNG();

    let result = await findImageOnScreen(relativePath, image);

    if (!result) {
      throw new AiError(`Image not found: ${relativePath}`, true);
    } else {
      if (action === "click") {
        await click(result.centerX, result.centerY, action);
      } else if (action === "hover") {
        await hover(result.centerX, result.centerY);
      }
    }

    return true;
  },
  // type a string
  type: async (string, delay = 250) => {
    await redraw.start();

    string = string.toString();

    await sandbox.send({ type: "write", text: string, delay });
    await redraw.wait(5000);
    return;
  },
  // press keys
  // different than `type`, becasue it can press multiple keys at once
  "press-keys": async (inputKeys) => {
    await redraw.start();

    // finally, press the keys
    await sandbox.send({ type: "press", keys: inputKeys });

    await redraw.wait(5000);

    return;
  },
  // simple delay, usually to let ui render or webpage to load
  wait: async (timeout = 3000) => {
    return await delay(timeout);
  },
  "wait-for-image": async (description, timeout = 10000) => {
    logger.info("");
    logger.info(
      theme.dim(
        `waiting for an image matching description "${description}"...`,
      ),
      true,
    );

    let startTime = new Date().getTime();
    let durationPassed = 0;
    let passed = false;

    while (durationPassed < timeout && !passed) {
      passed = await assert(
        `An image matching the description "${description}" appears on screen.`,
        false,
        false,
      );

      durationPassed = new Date().getTime() - startTime;
      if (!passed) {
        logger.info(
          theme.dim(
            `${niceSeconds(durationPassed)} seconds have passed without finding an image matching the description "${description}"`,
          ),
          true,
        );
        await delay(2500);
      }
    }

    if (passed) {
      logger.info(
        theme.dim(`An image matching the description "${description}" found!`),
        true,
      );
      return;
    } else {
      throw new AiError(
        `Timed out (${niceSeconds(timeout)} seconds) while searching for an image matching the description "${description}"`,
        true,
      );
    }
  },
  "wait-for-text": async (text, timeout = 5000, method = "turbo") => {
    console.log(text);

    await redraw.start();

    logger.info(theme.dim(`waiting for text: "${text}"...`), true);

    let startTime = new Date().getTime();
    let durationPassed = 0;

    let passed = false;

    while (durationPassed < timeout && !passed) {
      const response = await sdk.req(
        "assert/text",
        {
          needle: text,
          method: method,
          image: await captureScreenBase64(),
        },
        (chunk) => {
          if (chunk.type === "closeMatches") {
            emitter.emit(events.matches.show, chunk.data);
          }
        },
      );

      passed = response.data;
      durationPassed = new Date().getTime() - startTime;
      if (!passed) {
        logger.info(
          theme.dim(
            `${niceSeconds(durationPassed)} seconds have passed without finding "${text}"`,
          ),
          true,
        );
        await delay(2500);
      }
    }

    if (passed) {
      logger.info(theme.dim(`"${text}" found!`), true);
      return;
    } else {
      throw new AiError(
        `Timed out (${niceSeconds(timeout)} seconds) while searching for "${text}:.}`,
        true,
      );
    }
  },
  "scroll-until-text": async (
    text,
    direction = "down",
    maxDistance = 1200,
    textMatchMethod = "turbo",
    method = "keyboard",
  ) => {
    await redraw.start();

    logger.info(theme.dim(`scrolling for text: "${text}"...`), true);

    if (method === "keyboard") {
      try {
        await sandbox.send({ type: "press", keys: ["f", "ctrl"] });
        await delay(1000);
        await sandbox.send({ type: "write", text });
        await redraw.wait(5000);
        await sandbox.send({ type: "press", keys: ["escape"] });
      } catch (e) {
        logger.error("%s", e);
        throw new AiError(
          "Could not find element using browser text search",
          true,
        );
      }
    }

    let scrollDistance = 0;
    let incrementDistance = 300;
    if (method === "mouse") {
      incrementDistance = 200;
    }
    let passed = false;

    while (scrollDistance <= maxDistance && !passed) {
      const response = await sdk.req(
        "assert/text",
        {
          needle: text,
          method: textMatchMethod,
          image: await captureScreenBase64(),
        },
        (chunk) => {
          if (chunk.type === "closeMatches") {
            emitter.emit(events.matches.show, chunk.data);
          }
        },
      );

      passed = response.data;
      if (!passed) {
        logger.info(
          theme.dim(
            `scrolling ${direction} ${incrementDistance}px. ${scrollDistance + incrementDistance}/${maxDistance}px scrolled...`,
          ),
          true,
        );
        await scroll(direction, incrementDistance, method);
        scrollDistance = scrollDistance + incrementDistance;
      }
    }

    if (passed) {
      logger.info(theme.dim(`"${text}" found!`), true);
      return;
    } else {
      throw new AiError(
        `Scrolled ${scrollDistance} pixels without finding "${text}"`,
        true,
      );
    }
  },
  "scroll-until-image": async (
    description,
    direction = "down",
    maxDistance = 10000,
    method = "keyboard",
    path,
  ) => {
    const needle = description || path;

    if (!needle) {
      throw new AiError("No description or path provided");
    }

    if (description && path) {
      throw new AiError("Only one of description or path can be provided");
    }

    logger.info(
      theme.dim(`scrolling for an image matching "${needle}"...`),
      true,
    );

    let scrollDistance = 0;
    let incrementDistance = 500;
    let passed = false;

    while (scrollDistance <= maxDistance && !passed) {
      if (description) {
        passed = await assert(
          `An image matching the description "${description}" appears on screen.`,
          false,
          false,
        );
      }

      if (path) {
        // Don't throw if not found. We only want to know if it's found or not.
        passed = await commands["match-image"](path, null).catch(console.warn);
      }

      if (!passed) {
        logger.info(
          theme.dim(`scrolling ${direction} ${incrementDistance} pixels...`),
          true,
        );
        await scroll(direction, incrementDistance, method);
        scrollDistance = scrollDistance + incrementDistance;
      }
    }

    if (passed) {
      logger.info(theme.dim(`"${needle}" found!`), true);
      return;
    } else {
      throw new AiError(
        `Scrolled ${scrollDistance} pixels without finding an image matching "${needle}"`,
        true,
      );
    }
  },
  // run applescript to focus an application by name
  "focus-application": async (name) => {
    await redraw.start();

    await sandbox.send({
      type: "commands.focus-application",
      name,
    });
    await redraw.wait(1000);
    return "The application was focused.";
  },
  remember: async (description) => {
    let result = await sdk.req("remember", {
      image: await captureScreenBase64(),
      description,
    });
    return result.data;
  },
  assert: async (assertion, async = false) => {
    return await assert(assertion, true, async);
  },
  exec: async (language, code, silent = false) => {
    logger.info(theme.dim(`calling exec...`), true);

    console.log(code);

    let plat = platform();

    if (language == "pwsh") {
      let result = null;

      result = await sandbox.send({
        type: "commands.run",
        command: code,
      });

      if (result.out && result.out.returncode !== 0) {
        throw new AiError(
          `Command failed with exit code ${result.out.returncode}: ${result.out.stderr}`,
          true,
        );
      } else {
        if (!silent) {
          logger.info(theme.dim(`Command stdout:`), true);
          logger.info(`${result.out.stdout}`, true);

          if (result.out.stderr) {
            logger.info(theme.dim(`Command stderr:`), true);
            logger.info(`${result.out.stderr}`, true);
          }
        }

        return result.out?.stdout?.trim();
      }
    } else if (language == "js") {
      logger.info(theme.dim(`running js...`), true);

      logger.info(
        theme.dim(`running value of \`${plat}\` in local JS vm...`),
        true,
      );

      console.log("");
      console.log("------");

      const context = vm.createContext({
        require,
        console,
        fs,
        process,
        fetch,
      });

      let scriptCode = "(async function() {\n" + code + "\n})();";

      const script = new vm.Script(scriptCode);

      try {
        await script.runInNewContext(context);
      } catch (e) {
        console.error(e);
        throw new AiError(`Error running script: ${e.message}`, true);
      }

      // wait for context.result to resolve
      let stepResult = await context.result;

      // conver it to string
      if (typeof stepResult === "object") {
        stepResult = JSON.stringify(stepResult, null, 2);
      } else if (typeof stepResult === "function") {
        stepResult = stepResult.toString();
      }

      console.log("------");
      console.log("");

      if (!stepResult) {
        logger.info(`No result returned from script`, true);
      } else {
        if (!silent) {
          logger.info(theme.dim(`Result:`), true);
          logger.info(stepResult, true);
        }
      }

      return stepResult;
      // }
    } else {
      throw new AiError(`Language not supported: ${language}`);
    }
  },
};

module.exports = { commands, assert };
