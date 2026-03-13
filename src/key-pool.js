// key-pool.js — Key pool management: selection, cooldown, quota tracking
// Key 池管理：選取、cooldown、配額追蹤
"use strict";

const fs = require("fs");
const path = require("path");

class KeyPool {
  /**
   * @param {object} keysConfig - providers section from keys.json / keys.json 的 providers 區塊
   * @param {object} opts
   * @param {object} opts.cooldown - cooldown duration config / cooldown 時間設定
   * @param {string} opts.stateFile - persistent state file path / 持久化狀態檔路徑
   * @param {number} opts.stateSaveIntervalMs - auto-save interval / 自動存檔間隔
   * @param {function} opts.onNotify - notification callback / 通知回呼 (text) => void
   */
  constructor(keysConfig, opts = {}) {
    this.providers = new Map(); // providerName -> { baseUrl, keys: Map<token, KeyState> }
    this.cooldownConfig = opts.cooldown || {};
    this.stateFile = opts.stateFile || "./data/state.json";
    this.onNotify = opts.onNotify || (() => {});

    // Load key definitions / 載入 key 定義
    for (const [name, provider] of Object.entries(keysConfig)) {
      const keys = new Map();
      for (const k of provider.keys) {
        keys.set(k.token, {
          token: k.token,
          label: k.label || k.token.slice(-6),
          priority: k.priority || 1,
          weeklyBudget: k.weeklyBudget || Infinity,
          // Dynamic state / 動態狀態
          cooldownUntil: 0,
          weeklySpent: 0,
          weekStart: this._currentWeekStart(),
          totalRequests: 0,
          totalErrors: 0,
        });
      }
      this.providers.set(name, {
        baseUrl: provider.baseUrl,
        authMode: provider.authMode || "bearer",
        keys,
      });
    }

    // Load persistent state / 載入持久化狀態
    this._loadState();

    // Periodic save / 定期存檔
    if (opts.stateSaveIntervalMs > 0) {
      this._saveTimer = setInterval(
        () => this.saveState(),
        opts.stateSaveIntervalMs
      );
      this._saveTimer.unref();
    }
  }

  /**
   * Pick an available key (random selection, excluding cooldown and over-quota)
   * 選取可用的 key（隨機選取，排除 cooldown 和超額的）
   * @param {string} providerName
   * @returns {{ token: string, label: string, baseUrl: string } | null}
   */
  pickKey(providerName) {
    const provider = this.providers.get(providerName);
    if (!provider) return null;

    const now = Date.now();
    const available = [];

    for (const ks of provider.keys.values()) {
      // Check weekly quota reset / 週額度重置檢查
      this._checkWeekReset(ks);

      if (ks.cooldownUntil > now) continue;
      if (ks.weeklySpent >= ks.weeklyBudget) continue;
      available.push(ks);
    }

    if (available.length === 0) return null;

    // Random selection to avoid multiple agents hitting the same key
    // 隨機選取，避免多 agent 同時打同一把
    const picked = available[Math.floor(Math.random() * available.length)];
    picked.totalRequests++;

    return {
      token: picked.token,
      label: picked.label,
      baseUrl: provider.baseUrl,
      authMode: provider.authMode,
    };
  }

  /**
   * Report successful key usage, record cost
   * 回報 key 使用成功，記錄花費
   * @param {string} providerName
   * @param {string} token
   * @param {number} cost - cost in USD / 本次花費（美元）
   */
  reportSuccess(providerName, token, cost = 0) {
    const ks = this._getKeyState(providerName, token);
    if (!ks) return;

    this._checkWeekReset(ks);
    ks.weeklySpent += cost;

    // Weekly quota warning at 90% / 週額度 90% 警告
    if (
      ks.weeklyBudget < Infinity &&
      ks.weeklySpent >= ks.weeklyBudget * 0.9 &&
      ks.weeklySpent - cost < ks.weeklyBudget * 0.9
    ) {
      this.onNotify(
        `⚠️ [${providerName}] Key "${ks.label}" weekly quota ${(ks.weeklySpent).toFixed(2)}/${ks.weeklyBudget.toFixed(2)} USD (>90%)`
      );
    }
  }

  /**
   * Report key failure, enter cooldown
   * 回報 key 使用失敗，進入 cooldown
   * @param {string} providerName
   * @param {string} token
   * @param {number} statusCode - HTTP status code
   * @param {string} [errorMsg]
   */
  reportFailure(providerName, token, statusCode, errorMsg = "") {
    const ks = this._getKeyState(providerName, token);
    if (!ks) return;

    ks.totalErrors++;

    const cd = this.cooldownConfig;
    let cooldownMs;
    if (statusCode === 429) {
      cooldownMs = cd["429Ms"] || 300_000;
    } else if (statusCode >= 500) {
      cooldownMs = cd["5xxMs"] || 30_000;
    } else if (statusCode === 0) {
      // timeout / network error
      cooldownMs = cd.timeoutMs || 15_000;
    } else {
      cooldownMs = cd.defaultMs || 60_000;
    }

    ks.cooldownUntil = Date.now() + cooldownMs;

    const reason =
      statusCode === 429
        ? "rate limited"
        : statusCode >= 500
          ? "server error"
          : statusCode === 0
            ? "timeout/network error"
            : `HTTP ${statusCode}`;
    const cdSec = Math.round(cooldownMs / 1000);
    console.log(
      `[KeyPool] ${providerName}/"${ks.label}" cooldown ${cdSec}s (${reason}${errorMsg ? ": " + errorMsg : ""})`
    );

    // Check if all keys are unavailable / 檢查是否全部 key 都不可用
    const provider = this.providers.get(providerName);
    if (provider) {
      const now = Date.now();
      const anyAvailable = [...provider.keys.values()].some(
        (k) => k.cooldownUntil <= now && k.weeklySpent < k.weeklyBudget
      );
      if (!anyAvailable) {
        this.onNotify(
          `🚨 [${providerName}] All API keys unavailable! Next available: ${this._nextAvailableTime(providerName)}`
        );
      }
    }
  }

  /**
   * Get status summary for all keys of a provider
   * 取得 provider 所有 key 的狀態摘要
   */
  getStatus(providerName) {
    const provider = this.providers.get(providerName);
    if (!provider) return null;

    const now = Date.now();
    const keys = [];
    for (const ks of provider.keys.values()) {
      this._checkWeekReset(ks);
      keys.push({
        label: ks.label,
        available: ks.cooldownUntil <= now && ks.weeklySpent < ks.weeklyBudget,
        cooldownRemaining:
          ks.cooldownUntil > now
            ? Math.round((ks.cooldownUntil - now) / 1000)
            : 0,
        weeklySpent: ks.weeklySpent,
        weeklyBudget: ks.weeklyBudget,
        totalRequests: ks.totalRequests,
        totalErrors: ks.totalErrors,
      });
    }
    return { baseUrl: provider.baseUrl, keys };
  }

  /**
   * Get all provider names / 取得所有 provider 名稱
   */
  getProviderNames() {
    return [...this.providers.keys()];
  }

  /**
   * Persist state to file / 持久化狀態到檔案
   */
  saveState() {
    const state = {};
    for (const [name, provider] of this.providers) {
      state[name] = {};
      for (const [token, ks] of provider.keys) {
        // Only save dynamic fields; hash token to avoid plaintext leak
        // 只存動態欄位，token 做 hash 避免明文洩漏
        const id = this._hashToken(token);
        state[name][id] = {
          cooldownUntil: ks.cooldownUntil,
          weeklySpent: ks.weeklySpent,
          weekStart: ks.weekStart,
          totalRequests: ks.totalRequests,
          totalErrors: ks.totalErrors,
        };
      }
    }

    try {
      const dir = path.dirname(this.stateFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error(`[KeyPool] Failed to save state / 儲存狀態失敗: ${err.message}`);
    }
  }

  destroy() {
    if (this._saveTimer) clearInterval(this._saveTimer);
    this.saveState();
  }

  // --- private ---

  _loadState() {
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const state = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));

      for (const [name, provider] of this.providers) {
        const providerState = state[name];
        if (!providerState) continue;

        for (const [token, ks] of provider.keys) {
          const id = this._hashToken(token);
          const saved = providerState[id];
          if (!saved) continue;

          ks.cooldownUntil = saved.cooldownUntil || 0;
          ks.weeklySpent = saved.weeklySpent || 0;
          ks.weekStart = saved.weekStart || this._currentWeekStart();
          ks.totalRequests = saved.totalRequests || 0;
          ks.totalErrors = saved.totalErrors || 0;
        }
      }
      console.log("[KeyPool] Persistent state loaded / 已載入持久化狀態");
    } catch (err) {
      console.error(`[KeyPool] Failed to load state / 載入狀態失敗: ${err.message}`);
    }
  }

  _getKeyState(providerName, token) {
    const provider = this.providers.get(providerName);
    if (!provider) return null;
    return provider.keys.get(token) || null;
  }

  _checkWeekReset(ks) {
    const currentWeek = this._currentWeekStart();
    if (ks.weekStart !== currentWeek) {
      ks.weeklySpent = 0;
      ks.weekStart = currentWeek;
    }
  }

  _currentWeekStart() {
    // Reset every Monday 00:00 UTC / 每週一 00:00 UTC 重置
    const now = new Date();
    const day = now.getUTCDay(); // 0=Sun, 1=Mon
    const diff = day === 0 ? 6 : day - 1; // days since Monday
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() - diff);
    monday.setUTCHours(0, 0, 0, 0);
    return monday.toISOString().split("T")[0]; // "2026-03-09"
  }

  _nextAvailableTime(providerName) {
    const provider = this.providers.get(providerName);
    if (!provider) return "unknown";

    let earliest = Infinity;
    for (const ks of provider.keys.values()) {
      if (ks.weeklySpent >= ks.weeklyBudget) continue;
      if (ks.cooldownUntil < earliest) earliest = ks.cooldownUntil;
    }
    if (earliest === Infinity) return "after weekly reset / 下週重置後";
    return new Date(earliest).toISOString();
  }

  _hashToken(token) {
    // Simple hash for state file to avoid plaintext tokens
    // 簡易 hash，用於 state file 避免明文 token
    const crypto = require("crypto");
    return crypto.createHash("sha256").update(token).digest("hex").slice(0, 12);
  }
}

module.exports = { KeyPool };
