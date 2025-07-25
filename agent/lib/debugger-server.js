const WebSocket = require("ws");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { eventsArray } = require("../events.js");

let server = null;
let wss = null;
let clients = new Set();

function createDebuggerServer(config = {}) {
  const port = config.TD_DEBUGGER_PORT || 0; // 0 means find available port

  return new Promise((resolve, reject) => {
    // Create HTTP server
    server = http.createServer((req, res) => {
      const url = req.url;

      // Parse URL to get pathname without query parameters
      const urlObj = new URL(url, `http://${req.headers.host}`);
      const pathname = urlObj.pathname;

      // Serve static files from debugger directory
      let filePath;
      if (pathname === "/" || pathname === "/index.html") {
        filePath = path.join(__dirname, "..", "..", "debugger", "index.html");
      } else {
        // Remove leading slash and serve from debugger directory
        const cleanUrl = pathname.startsWith("/")
          ? pathname.substring(1)
          : pathname;
        filePath = path.join(__dirname, "..", "..", "debugger", cleanUrl);
      }

      // Check if file exists
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath);
        const contentType =
          {
            ".html": "text/html",
            ".css": "text/css",
            ".js": "application/javascript",
            ".json": "application/json",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".svg": "image/svg+xml",
            ".ico": "image/x-icon",
          }[ext] || "application/octet-stream";

        res.writeHead(200, { "Content-Type": contentType });
        fs.createReadStream(filePath).pipe(res);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    // Create WebSocket server
    wss = new WebSocket.Server({ server });

    wss.on("connection", (ws) => {
      clients.add(ws);

      ws.on("close", () => {
        clients.delete(ws);

        // If no clients connected, we can optionally shut down
        if (clients.size === 0) {
          console.log("No clients connected, keeping server alive");
        }
      });

      ws.on("error", (error) => {
        console.error("WebSocket client error:", error);
        clients.delete(ws);
      });
    });

    // Start server on available port
    server.listen(port, "localhost", () => {
      const actualPort = server.address().port;
      resolve({ port: actualPort, server, wss });
    });

    server.on("error", (error) => {
      console.error("Server error:", error);
      reject(error);
    });
  });
}

function broadcastEvent(event, data) {
  if (clients.size === 0) {
    return;
  }

  const message = JSON.stringify({ event, data });

  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

async function startDebugger(config = {}, emitter) {
  try {
    const { port } = await createDebuggerServer(config);
    const url = `http://localhost:${port}`;

    // Set up event listeners for all events
    for (const event of eventsArray) {
      emitter.on(event, async (data) => {
        broadcastEvent(event, data);
      });
    }

    return { port, url };
  } catch (error) {
    console.error("Failed to start debugger server:", error);
    throw error;
  }
}

function stopDebugger() {
  if (wss) {
    wss.close();
    wss = null;
  }

  if (server) {
    server.close();
    server = null;
  }

  clients.clear();
  console.log("Debugger server stopped");
}

module.exports = {
  startDebugger,
  stopDebugger,
  broadcastEvent,
  createDebuggerServer,
};
