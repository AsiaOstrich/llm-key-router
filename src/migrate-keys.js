#!/usr/bin/env node
// migrate-keys.js — Migrate existing key files to llm-key-router keys.json
// 從既有的 key 檔案格式轉換為 llm-key-router keys.json
//
// Usage / 用法: node src/migrate-keys.js [--ollama path] [--gemini path] [output-path]
//
// Default input / 預設輸入:
//   ~/.secrets/ollama_keys.json   (Ollama Cloud)
//   ~/.secrets/gemini_keys.json   (Gemini)
// Output / 輸出:
//   keys.json (llm-key-router format / llm-key-router 格式)
"use strict";

const fs = require("fs");
const path = require("path");

const HOME = process.env.HOME || process.env.USERPROFILE || "/tmp";

// Parse args / 解析參數
let ollamaPath = path.join(HOME, ".secrets/ollama_keys.json");
let geminiPath = path.join(HOME, ".secrets/gemini_keys.json");
let outputPath = "./keys.json";

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--ollama" && args[i + 1]) {
    ollamaPath = args[++i];
  } else if (args[i] === "--gemini" && args[i + 1]) {
    geminiPath = args[++i];
  } else if (!args[i].startsWith("--")) {
    outputPath = args[i];
  }
}

function loadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

const result = { providers: {} };

// --- Ollama Cloud ---
const ollama = loadJson(ollamaPath);
if (ollama && ollama.keys && ollama.keys.length > 0) {
  result.providers["ollama-cloud"] = {
    baseUrl: "https://api.ollama.com",
    keys: ollama.keys.map((k, i) => ({
      token: k.token,
      label: k.id || k.note || `ollama-${i}`,
      weeklyBudget: 5.0,
      priority: i + 1,
    })),
  };
  console.log(`ollama-cloud: ${ollama.keys.length} keys`);
} else {
  console.log("ollama-cloud: no keys or file not found / 無 key 或檔案不存在");
}

// --- Gemini ---
const gemini = loadJson(geminiPath);
if (gemini && gemini.keys && gemini.keys.length > 0) {
  result.providers["gemini"] = {
    baseUrl: "https://generativelanguage.googleapis.com",
    keys: gemini.keys.map((k, i) => ({
      token: k.token,
      label: k.id || k.note || `gemini-${i}`,
      weeklyBudget: 10.0,
      priority: i + 1,
    })),
  };
  console.log(`gemini: ${gemini.keys.length} keys`);
} else {
  console.log("gemini: no keys or file not found / 無 key 或檔案不存在");
}

if (Object.keys(result.providers).length === 0) {
  console.error("Error: no key files found / 錯誤: 找不到任何 key 檔案");
  process.exit(1);
}

fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
console.log(`\nOutput written to / 已輸出: ${outputPath}`);
