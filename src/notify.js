// notify.js — Telegram notifications / Telegram 通知
"use strict";

const https = require("https");

const NOTIFY_COOLDOWN_MS = 60_000;
const lastNotifyTime = new Map(); // key -> timestamp

/**
 * Create Telegram notifier function / 建立 Telegram 通知函式
 * @param {object} opts
 * @param {string} opts.botToken
 * @param {string} opts.chatId
 * @returns {function} (text: string) => void
 */
function createNotifier(opts = {}) {
  const { botToken, chatId } = opts;

  if (!botToken || !chatId) {
    console.log("[Notify] Telegram not configured, notifications disabled");
    return () => {};
  }

  console.log("[Notify] Telegram notifications enabled");

  return function notify(text) {
    // Deduplicate same message within cooldown / 同一訊息 cooldown
    const now = Date.now();
    const last = lastNotifyTime.get(text) || 0;
    if (now - last < NOTIFY_COOLDOWN_MS) return;
    lastNotifyTime.set(text, now);

    const postData = JSON.stringify({ chat_id: chatId, text });
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${botToken}/sendMessage`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        res.resume();
        if (res.statusCode !== 200) {
          console.error(`[Notify] Telegram HTTP ${res.statusCode}`);
        }
      }
    );
    req.on("error", (err) => {
      console.error(`[Notify] Telegram error: ${err.message}`);
    });
    req.write(postData);
    req.end();
  };
}

module.exports = { createNotifier };
