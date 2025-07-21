const os = require("os");
const path = require("path");
const { compare } = require("odiff-bin");
const { events } = require("../events");
const theme = require("./theme");

// Factory function that creates redraw functionality with the provided system instance
const createRedraw = (emitter, system, sandbox) => {
  const redrawThresholdPercent = 0.1;
  const networkUpdateInterval = 2000;

  let lastTxBytes = null;
  let lastRxBytes = null;

  let diffRxBytes = 0;
  let diffTxBytes = 0;

  let measurements = [];
  let networkSettled = true;
  let screenHasRedrawn = null;

  async function resetState() {
    lastTxBytes = null;
    lastRxBytes = null;
    measurements = [];
    networkSettled = true;
    screenHasRedrawn = false;
  }

  const parseNetworkStats = (thisRxBytes, thisTxBytes) => {
    diffRxBytes = lastRxBytes !== null ? thisRxBytes - lastRxBytes : 0;
    diffTxBytes = lastTxBytes !== null ? thisTxBytes - lastTxBytes : 0;

    lastRxBytes = thisRxBytes;
    lastTxBytes = thisTxBytes;

    measurements.push({ rx: diffRxBytes, tx: diffTxBytes });

    if (measurements.length > 60) {
      measurements.shift();
    }

    let avgRx =
      measurements.reduce((acc, m) => acc + m.rx, 0) / measurements.length;
    let avgTx =
      measurements.reduce((acc, m) => acc + m.tx, 0) / measurements.length;

    let stdDevRx = Math.sqrt(
      measurements.reduce((acc, m) => acc + Math.pow(m.rx - avgRx, 2), 0) /
        measurements.length,
    );
    let stdDevTx = Math.sqrt(
      measurements.reduce((acc, m) => acc + Math.pow(m.tx - avgTx, 2), 0) /
        measurements.length,
    );

    let zIndexRx = stdDevRx !== 0 ? (diffRxBytes - avgRx) / stdDevRx : 0;
    let zIndexTx = stdDevTx !== 0 ? (diffTxBytes - avgTx) / stdDevTx : 0;

    if (zIndexRx < 0 && zIndexTx < 0) {
      networkSettled = true;
    } else {
      networkSettled = false;
    }
  };

  async function updateNetwork() {
    if (sandbox && sandbox.instanceSocketConnected) {
      let network = await sandbox.send({
        type: "system.network",
      });
      parseNetworkStats(
        network.out.totalBytesReceived,
        network.out.totalBytesSent,
      );
    }
  }

  async function imageDiffPercent(image1Url, image2Url) {
    // generate a temporary file path
    const tmpImage = path.join(os.tmpdir(), `tmp-${Date.now()}.png`);

    const { reason, diffPercentage, match } = await compare(
      image1Url,
      image2Url,
      tmpImage,
      {
        failOnLayoutDiff: false,
        outputDiffMask: false,
      },
    );

    if (match) {
      return false;
    } else {
      if (reason === "pixel-diff") {
        return diffPercentage.toFixed(1);
      } else {
        return false;
      }
    }
  }

  let startImage = null;

  async function start() {
    resetState();
    startImage = await system.captureScreenPNG(0.25, true);
    return startImage;
  }

  async function checkCondition(resolve, startTime, timeoutMs) {
    let nowImage = await system.captureScreenPNG(0.25, true);
    let timeElapsed = Date.now() - startTime;
    let diffPercent = 0;
    let isTimeout = timeElapsed > timeoutMs;

    if (!screenHasRedrawn) {
      diffPercent = await imageDiffPercent(startImage, nowImage);
      screenHasRedrawn = diffPercent > redrawThresholdPercent;
    }

    // // log redraw as output
    let redrawText = screenHasRedrawn
      ? theme.green(`y`)
      : theme.dim(`${diffPercent}/${redrawThresholdPercent}%`);
    let networkText = networkSettled
      ? theme.green(`y`)
      : theme.dim(
          `${Math.trunc((diffRxBytes + diffTxBytes) / networkUpdateInterval)}b/s`,
        );
    let timeoutText = isTimeout
      ? theme.green(`y`)
      : theme.dim(`${Math.floor(timeElapsed / 1000)}/${timeoutMs / 1000}s`);

    emitter.emit(events.redraw.status, {
      redraw: {
        hasRedrawn: screenHasRedrawn,
        diffPercent,
        threshold: redrawThresholdPercent,
        text: redrawText,
      },
      network: {
        settled: networkSettled,
        rxBytes: diffRxBytes,
        txBytes: diffTxBytes,
        text: networkText,
      },
      timeout: {
        isTimeout,
        elapsed: timeElapsed,
        max: timeoutMs,
        text: timeoutText,
      },
    });

    if ((screenHasRedrawn && networkSettled) || isTimeout) {
      emitter.emit(events.redraw.complete, {
        screenHasRedrawn,
        networkSettled,
        isTimeout,
        timeElapsed,
      });
      resolve("true");
    } else {
      setTimeout(() => {
        checkCondition(resolve, startTime, timeoutMs);
      }, 500);
    }
  }

  function wait(timeoutMs) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      checkCondition(resolve, startTime, timeoutMs);
    });
  }

  setInterval(updateNetwork, networkUpdateInterval);

  return { start, wait };
};

module.exports = { createRedraw };
