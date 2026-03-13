#!/usr/bin/env node
// llm-key-router — Lightweight LLM API Key management proxy
// 輕量級 LLM API Key 管理代理
// Usage / 啟動方式: node src/index.js [config.json]
"use strict";

const fs = require("fs");
const path = require("path");
const { KeyPool } = require("./key-pool");
const { createNotifier } = require("./notify");
const { createProxy } = require("./proxy");

// --- Load config / 載入設定 ---

const configPath = process.argv[2] || "./config.json";

if (!fs.existsSync(configPath)) {
  console.error(`Config file not found / 設定檔不存在: ${configPath}`);
  console.error("Copy config.example.json to config.json and edit it");
  console.error("請複製 config.example.json 為 config.json 並修改");
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const keysPath = config.keysFile || "./keys.json";

if (!fs.existsSync(keysPath)) {
  console.error(`Keys file not found / Key 檔不存在: ${keysPath}`);
  console.error("Copy keys.example.json to keys.json and edit it");
  console.error("請複製 keys.example.json 為 keys.json 並修改");
  process.exit(1);
}

const keysConfig = JSON.parse(fs.readFileSync(keysPath, "utf8"));

// --- Initialize / 初始化 ---

const notify = createNotifier(config.telegram || {});

const keyPool = new KeyPool(keysConfig.providers, {
  cooldown: config.cooldown || {},
  stateFile: config.stateFile || "./data/state.json",
  stateSaveIntervalMs: config.stateSaveIntervalMs || 30_000,
  onNotify: notify,
});

const PORT = config.port || 4000;
const server = createProxy(keyPool, {
  requestTimeoutMs: config.request?.timeoutMs || 120_000,
});

// --- Start / 啟動 ---

server.listen(PORT, "127.0.0.1", () => {
  const providers = keyPool.getProviderNames();
  console.log(`llm-key-router listening on http://127.0.0.1:${PORT}`);
  console.log(`Providers: ${providers.join(", ")}`);
  for (const name of providers) {
    const status = keyPool.getStatus(name);
    console.log(
      `  ${name}: ${status.keys.length} keys, baseUrl=${status.baseUrl}`
    );
  }
  console.log(`\nUsage: curl http://127.0.0.1:${PORT}/{provider}/v1/chat/completions`);
  console.log(`Status: curl http://127.0.0.1:${PORT}/status`);
});

// --- Graceful shutdown / 優雅關閉 ---

function shutdown(signal) {
  console.log(`\n[${signal}] Shutting down...`);
  keyPool.destroy();
  server.close(() => {
    console.log("Closed.");
    process.exit(0);
  });
  // Force exit after 5s / 5 秒後強制退出
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
