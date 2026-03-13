// proxy.js — HTTP reverse proxy: intercept requests, inject keys, failover retry
// HTTP 反向代理：攔截請求、注入 key、failover 重試
"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");

/**
 * Create proxy server / 建立 proxy server
 * @param {import('./key-pool').KeyPool} keyPool
 * @param {object} opts
 * @param {number} opts.requestTimeoutMs
 * @returns {http.Server}
 */
function createProxy(keyPool, opts = {}) {
  const requestTimeoutMs = opts.requestTimeoutMs || 120_000;

  const server = http.createServer((req, res) => {
    // Route format: /{provider}/v1/chat/completions
    // 路由格式: /{provider}/v1/chat/completions
    const urlParts = req.url.split("/");

    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (req.url === "/status") {
      const status = {};
      for (const name of keyPool.getProviderNames()) {
        status[name] = keyPool.getStatus(name);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status, null, 2));
      return;
    }

    if (urlParts.length < 3) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Path format: /{provider}/v1/...",
          providers: keyPool.getProviderNames(),
        })
      );
      return;
    }

    const providerName = urlParts[1];
    const upstreamPath = "/" + urlParts.slice(2).join("/");

    if (!keyPool.getStatus(providerName)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: `Provider "${providerName}" not found`,
          providers: keyPool.getProviderNames(),
        })
      );
      return;
    }

    // Collect full request body / 收集完整 request body
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      tryRequest(providerName, upstreamPath, req, res, body, requestTimeoutMs);
    });
  });

  /**
   * Try request with available keys, retry with next key on failure
   * 嘗試用可用的 key 發送請求，失敗就換 key 重試
   */
  function tryRequest(
    providerName,
    upstreamPath,
    originalReq,
    res,
    body,
    timeoutMs,
    triedTokens = new Set()
  ) {
    const picked = keyPool.pickKey(providerName);

    // Filter already-tried keys / 過濾已嘗試過的 key
    if (picked && triedTokens.has(picked.token)) {
      const status = keyPool.getStatus(providerName);
      const maxRetries = status ? status.keys.length : 0;
      if (triedTokens.size >= maxRetries) {
        // All keys exhausted / 全部試過了
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: `[${providerName}] All API keys unavailable`,
            tried: triedTokens.size,
          })
        );
        return;
      }
      // Recursive retry (pickKey will randomly select again)
      // 遞迴重試（會再 pickKey 隨機選）
      tryRequest(
        providerName,
        upstreamPath,
        originalReq,
        res,
        body,
        timeoutMs,
        triedTokens
      );
      return;
    }

    if (!picked) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: `[${providerName}] All API keys unavailable`,
          tried: triedTokens.size,
        })
      );
      return;
    }

    triedTokens.add(picked.token);

    const upstream = new URL(picked.baseUrl);
    const isHttps = upstream.protocol === "https:";
    const transport = isHttps ? https : http;
    const defaultPort = isHttps ? 443 : 80;

    // Build auth header based on authMode / 依 authMode 建構認證 header
    const authHeaders = buildAuthHeaders(picked.authMode, picked.token);

    const proxyOpts = {
      hostname: upstream.hostname,
      port: upstream.port || defaultPort,
      path: upstreamPath,
      method: originalReq.method,
      headers: {
        ...filterHeaders(originalReq.headers),
        host: upstream.host,
        ...authHeaders,
      },
      timeout: timeoutMs,
    };

    if (body.length > 0) {
      proxyOpts.headers["content-length"] = body.length;
    }

    const ts = new Date().toISOString();
    console.log(
      `[${ts}] ${originalReq.method} ${providerName}${upstreamPath} -> key="${picked.label}"`
    );

    const proxyReq = transport.request(proxyOpts, (proxyRes) => {
      const statusCode = proxyRes.statusCode;

      // Success: pipe response back / 成功：直接 pipe 回去
      if (statusCode >= 200 && statusCode < 400) {
        keyPool.reportSuccess(providerName, picked.token, 0);
        res.writeHead(statusCode, filterHeaders(proxyRes.headers));
        proxyRes.pipe(res);
        return;
      }

      // Failure: collect error response, decide whether to retry
      // 失敗：收集錯誤回應，決定是否重試
      const errChunks = [];
      proxyRes.on("data", (c) => errChunks.push(c));
      proxyRes.on("end", () => {
        const errBody = Buffer.concat(errChunks).toString();
        const errMsg = extractErrorMessage(errBody);

        console.error(
          `[${new Date().toISOString()}] ${providerName}/"${picked.label}" HTTP ${statusCode}: ${errMsg}`
        );
        keyPool.reportFailure(providerName, picked.token, statusCode, errMsg);

        // Try next key / 嘗試下一把 key
        tryRequest(
          providerName,
          upstreamPath,
          originalReq,
          res,
          body,
          timeoutMs,
          triedTokens
        );
      });
    });

    proxyReq.on("error", (err) => {
      console.error(
        `[${new Date().toISOString()}] ${providerName}/"${picked.label}" error: ${err.message}`
      );
      keyPool.reportFailure(providerName, picked.token, 0, err.message);

      tryRequest(
        providerName,
        upstreamPath,
        originalReq,
        res,
        body,
        timeoutMs,
        triedTokens
      );
    });

    proxyReq.on("timeout", () => {
      proxyReq.destroy();
      console.error(
        `[${new Date().toISOString()}] ${providerName}/"${picked.label}" timeout (${timeoutMs}ms)`
      );
      keyPool.reportFailure(providerName, picked.token, 0, "timeout");

      tryRequest(
        providerName,
        upstreamPath,
        originalReq,
        res,
        body,
        timeoutMs,
        triedTokens
      );
    });

    if (body.length > 0) {
      proxyReq.write(body);
    }
    proxyReq.end();
  }

  return server;
}

/**
 * Build auth headers based on authMode / 依 authMode 建構認證 headers
 * - "bearer" (default) → Authorization: Bearer <token>
 * - "header:<name>" → { <name>: <token> }  (e.g. Gemini's x-goog-api-key)
 * @param {string} authMode
 * @param {string} token
 * @returns {object}
 */
function buildAuthHeaders(authMode, token) {
  if (!authMode || authMode === "bearer") {
    return { authorization: `Bearer ${token}` };
  }
  if (authMode.startsWith("header:")) {
    const headerName = authMode.slice("header:".length);
    return { [headerName]: token };
  }
  // Unknown authMode fallback to bearer / 未知 authMode 退回 bearer
  return { authorization: `Bearer ${token}` };
}

/**
 * Filter hop-by-hop headers / 過濾 hop-by-hop headers
 */
function filterHeaders(headers) {
  const filtered = {};
  const hopByHop = new Set([
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "proxy-authorization",
    "proxy-authenticate",
  ]);
  for (const [k, v] of Object.entries(headers)) {
    if (!hopByHop.has(k.toLowerCase())) {
      filtered[k] = v;
    }
  }
  return filtered;
}

/**
 * Extract error message from JSON response / 從 JSON 錯誤回應中擷取訊息
 */
function extractErrorMessage(body) {
  try {
    const obj = JSON.parse(body);
    return (
      obj.error?.message || obj.error?.type || obj.message || body.slice(0, 200)
    );
  } catch {
    return body.slice(0, 200);
  }
}

module.exports = { createProxy };
