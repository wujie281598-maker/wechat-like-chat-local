// HTTPS 反向代理 + 静态文件服务
// 可通过环境变量配置：
//   PROXY_PORT    - 监听端口，默认 8443
//   BACKEND_URL   - 后端地址，默认 http://127.0.0.1:4000
//   DIST_DIR      - 前端静态文件目录，默认 apps/web/dist
//   SSL_KEY_PATH  - SSL 私钥路径，默认 /opt/realtime-chat/cert/youshen.top.key
//   SSL_CERT_PATH - SSL 证书路径，默认 /opt/realtime-chat/cert/youshen.top_bundle.crt
import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PROXY_PORT ?? 8443);
const BACKEND = process.env.BACKEND_URL ?? "http://127.0.0.1:4000";
const DIST_DIR = process.env.DIST_DIR
  ? path.resolve(process.env.DIST_DIR)
  : path.join(__dirname, "apps/web/dist");

const backendUrl = new URL(BACKEND);
const BACKEND_HOST = backendUrl.hostname;
const BACKEND_PORT = Number(
  backendUrl.port || (backendUrl.protocol === "https:" ? 443 : 80)
);

const SSL_KEY_PATH = process.env.SSL_KEY_PATH ?? "/opt/realtime-chat/cert/youshen.top.key";
const SSL_CERT_PATH = process.env.SSL_CERT_PATH ?? "/opt/realtime-chat/cert/youshen.top_bundle.crt";

const options = {
  key: fs.readFileSync(SSL_KEY_PATH),
  cert: fs.readFileSync(SSL_CERT_PATH),
};

function isExpectedNetworkError(err) {
  return (
    err?.code === "ECONNRESET" ||
    err?.code === "EPIPE" ||
    err?.code === "ERR_STREAM_PREMATURE_CLOSE" ||
    err?.code === "HPE_INVALID_EOF_STATE" ||
    /socket hang up|client aborted|aborted|premature close/i.test(err?.message ?? "")
  );
}

function logProxyError(scope, err) {
  if (isExpectedNetworkError(err)) {
    console.warn(`${scope}: client connection closed`);
    return;
  }
  console.error(`${scope}:`, err?.message ?? err);
}

function safeJsonError(res, statusCode, message) {
  if (res.destroyed || res.writableEnded) return;
  try {
    if (!res.headersSent) {
      res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    }
    res.end(JSON.stringify({ error: message }));
  } catch {
    res.destroy();
  }
}

function destroyQuietly(stream) {
  if (!stream || stream.destroyed) return;
  try {
    stream.destroy();
  } catch {
    // Ignore cleanup errors caused by already closed client sockets.
  }
}

// MIME 类型
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

// 代理请求到后端
function proxyRequest(req, res) {
  const url = new URL(req.url, BACKEND);
  const proxyReq = http.request(
    {
      hostname: BACKEND_HOST,
      port: BACKEND_PORT,
      path: url.pathname + url.search,
      method: req.method,
      headers: { ...req.headers, host: `${BACKEND_HOST}:${BACKEND_PORT}` },
    },
    (proxyRes) => {
      if (res.destroyed || res.writableEnded) {
        destroyQuietly(proxyRes);
        return;
      }
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.on("error", (err) => {
        logProxyError("Proxy response error", err);
        destroyQuietly(res);
      });
      proxyRes.pipe(res);
    }
  );
  proxyReq.on("error", (err) => {
    logProxyError("Proxy request error", err);
    safeJsonError(res, 502, "后端服务暂时不可用，请稍后再试");
  });
  req.on("aborted", () => {
    destroyQuietly(proxyReq);
  });
  req.on("error", (err) => {
    logProxyError("Client request error", err);
    destroyQuietly(proxyReq);
  });
  res.on("close", () => {
    if (!res.writableEnded) destroyQuietly(proxyReq);
  });
  res.on("error", (err) => {
    logProxyError("Client response error", err);
    destroyQuietly(proxyReq);
  });
  req.pipe(proxyReq);
}

// 服务静态文件
function serveStatic(req, res) {
  let filePath = path.join(DIST_DIR, req.url === "/" ? "index.html" : req.url);
  // 安全检查：防止路径遍历
  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // SPA 路由回退到 index.html
      filePath = path.join(DIST_DIR, "index.html");
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || "application/octet-stream";
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      res.writeHead(200, { "Content-Type": contentType });
      res.end(data);
    });
  });
}

const server = https.createServer(options, (req, res) => {
  // API、上传、Socket.IO 轮询请求代理到后端
  if (
    req.url.startsWith("/api/") ||
    req.url.startsWith("/uploads/") ||
    req.url.startsWith("/socket.io/") ||
    req.url === "/health"
  ) {
    proxyRequest(req, res);
  } else {
    serveStatic(req, res);
  }
});

// WebSocket 升级（Socket.IO）
server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/socket.io/")) {
    let upgraded = false;
    const proxyReq = http.request({
      hostname: BACKEND_HOST,
      port: BACKEND_PORT,
      path: req.url,
      method: req.method,
      headers: req.headers,
    });
    const closeUpgrade = (err) => {
      if (err) logProxyError("WebSocket proxy error", err);
      destroyQuietly(proxyReq);
      destroyQuietly(socket);
    };
    socket.on("error", closeUpgrade);
    socket.on("close", () => {
      if (!upgraded) destroyQuietly(proxyReq);
    });
    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      upgraded = true;
      proxySocket.on("error", closeUpgrade);
      proxySocket.on("close", () => destroyQuietly(socket));
      socket.write("HTTP/1.1 101 Switching Protocols\r\n");
      Object.entries(proxyRes.headers).forEach(([key, value]) => {
        socket.write(`${key}: ${value}\r\n`);
      });
      socket.write("\r\n");
      if (proxyHead.length > 0) socket.write(proxyHead);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });
    proxyReq.on("response", (proxyRes) => {
      logProxyError(
        "WebSocket upgrade rejected",
        new Error(`backend returned ${proxyRes.statusCode}`)
      );
      destroyQuietly(proxyRes);
      closeUpgrade();
    });
    proxyReq.on("error", closeUpgrade);
    if (head.length > 0) {
      proxyReq.end(head);
    } else {
      proxyReq.end();
    }
  } else {
    destroyQuietly(socket);
  }
});

server.on("clientError", (err, socket) => {
  logProxyError("HTTPS client error", err);
  destroyQuietly(socket);
});

server.on("tlsClientError", (err, socket) => {
  logProxyError("TLS client error", err);
  destroyQuietly(socket);
});

process.on("uncaughtException", (err) => {
  if (isExpectedNetworkError(err)) {
    logProxyError("Ignored network exception", err);
    return;
  }
  console.error("Uncaught exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  if (isExpectedNetworkError(reason)) {
    logProxyError("Ignored network rejection", reason);
    return;
  }
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTPS proxy running at https://0.0.0.0:${PORT}`);
  console.log(`Backend: ${BACKEND}`);
  console.log(`Static files: ${DIST_DIR}`);
  console.log(`SSL key: ${SSL_KEY_PATH}`);
  console.log(`SSL cert: ${SSL_CERT_PATH}`);
});
