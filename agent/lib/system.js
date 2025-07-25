// utilities for getting information about the system
const fs = require("fs");
const os = require("os");
const path = require("path");
const Jimp = require("jimp");
const { events } = require("../events.js");

const createSystem = (sandbox, config, emitter) => {
  const screenshot = async (options, retryCount = 3) => {
    const maxRetries = retryCount;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        emitter.emit(events.log.debug, {
          message: `Taking screenshot to ${options.filename} (attempt ${attempt}/${maxRetries})`,
          data: { filename: options.filename, attempt, maxRetries },
        });

        emitter.emit(events.sandbox.sent, {
          message: "Sending screenshot request to sandbox",
          data: {
            type: "system.screenshot",
            filename: options.filename,
            attempt,
          },
        });

        let { base64 } = await sandbox.send({ type: "system.screenshot" });

        emitter.emit(events.sandbox.received, {
          message: "Received screenshot response from sandbox",
          data: {
            type: "system.screenshot",
            filename: options.filename,
            hasBase64: !!base64,
            base64Length: base64 ? base64.length : 0,
            attempt,
          },
        });

        if (!base64) {
          const errorMsg =
            "Failed to take screenshot - no base64 data received from sandbox";

          if (attempt === maxRetries) {
            emitter.emit(events.error.general, {
              message: errorMsg,
              data: {
                filename: options.filename,
                type: "screenshot",
                finalAttempt: true,
              },
            });
            emitter.emit(events.log.warn, {
              message: errorMsg,
              data: { filename: options.filename, finalAttempt: true },
            });
            throw new Error(errorMsg);
          } else {
            emitter.emit(events.log.warn, {
              message: `${errorMsg} - retrying in ${attempt * 1000}ms (attempt ${attempt}/${maxRetries})`,
              data: { filename: options.filename, attempt, willRetry: true },
            });

            // Exponential backoff: wait 1s, 2s, 3s, etc.
            await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
            continue;
          }
        } else {
          let image = Buffer.from(base64, "base64");
          fs.writeFileSync(options.filename, image);

          emitter.emit(events.log.debug, {
            message: `Screenshot saved successfully to ${options.filename}${attempt > 1 ? ` (succeeded on attempt ${attempt})` : ""}`,
            data: {
              filename: options.filename,
              size: image.length,
              attempt,
              succeededAfterRetries: attempt > 1,
            },
          });

          return { filename: options.filename };
        }
      } catch (error) {
        lastError = error;

        if (attempt === maxRetries) {
          const errorMsg = `Screenshot operation failed after ${maxRetries} attempts: ${error.message}`;
          emitter.emit(events.error.general, {
            message: errorMsg,
            error: error,
            data: {
              filename: options?.filename,
              type: "screenshot",
              attempts: maxRetries,
            },
          });
          emitter.emit(events.log.warn, {
            message: errorMsg,
            data: {
              filename: options?.filename,
              error: error.message,
              attempts: maxRetries,
            },
          });
          throw error;
        } else {
          emitter.emit(events.log.warn, {
            message: `Screenshot attempt ${attempt} failed: ${error.message} - retrying in ${attempt * 1000}ms`,
            data: {
              filename: options?.filename,
              error: error.message,
              attempt,
              willRetry: true,
            },
          });

          // Exponential backoff: wait 1s, 2s, 3s, etc.
          await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
        }
      }
    }

    // This should never be reached, but just in case
    throw lastError || new Error("Screenshot failed for unknown reason");
  };

  let primaryDisplay = null;

  const getSystemInformationOsInfo = async () => {
    return {
      os: "windows",
    };
  };

  let countImages = 0;
  const tmpFilename = () => {
    countImages = countImages + 1;
    return path.join(os.tmpdir(), `${new Date().getTime() + countImages}.png`);
  };

  const captureAndResize = async (scale = 1, silent = false, mouse = false) => {
    try {
      if (!silent) {
        emitter.emit(events.screenCapture.start, {
          scale,
          silent,
          display: primaryDisplay,
        });
      }

      let step1 = tmpFilename();
      let step2 = tmpFilename();

      await screenshot({ filename: step1, format: "png" });

      // Location of cursor image
      const cursorPath = path.join(__dirname, "resources", "cursor-2.png");

      const mousePos = await getMousePosition();

      // Load the screenshot image with Jimp
      let image = await Jimp.read(step1);

      // Resize the image
      image.resize(
        Math.floor(config.TD_RESOLUTION[0] * scale),
        Math.floor(config.TD_RESOLUTION[1] * scale),
      );

      if (mouse) {
        // Load and composite the mouse cursor image
        const cursorImage = await Jimp.read(cursorPath);

        image.composite(cursorImage, mousePos.x, mousePos.y);
      }

      await image.writeAsync(step2);

      emitter.emit(events.screenCapture.end, {
        scale,
        silent,
        display: primaryDisplay,
      });

      return step2;
    } catch (error) {
      emitter.emit(events.screenCapture.error, {
        error,
        scale,
        silent,
        display: primaryDisplay,
      });
      throw error;
    }
  };

  // our handy screenshot function
  const captureScreenBase64 = async (
    scale = 1,
    silent = false,
    mouse = false,
  ) => {
    let step2 = await captureAndResize(scale, silent, mouse);
    return fs.readFileSync(step2, "base64");
  };

  const captureScreenPNG = async (scale = 1, silent = false, mouse = false) => {
    return await captureAndResize(scale, silent, mouse);
  };

  const platform = () => {
    return "windows";
  };

  // this is the focused window
  const activeWin = async () => {
    // Get Mouse Position from command line
    let result = await sandbox.send({
      type: "system.get-active-window",
    });

    return result.out;
  };

  const getMousePosition = async () => {
    // Get Mouse Position from command line
    let result = await sandbox.send({
      type: "system.get-mouse-position",
    });

    return result.out;
  };

  return {
    captureScreenBase64,
    captureScreenPNG,
    getMousePosition,
    primaryDisplay,
    activeWin,
    platform,
    getSystemInformationOsInfo,
  };
};

module.exports = {
  createSystem,
};
