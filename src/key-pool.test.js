// key-pool.test.js — KeyPool unit tests / KeyPool 單元測試
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { KeyPool } = require("./key-pool");

const PROVIDER = "test-provider";

function makePool(keys, opts = {}) {
  return new KeyPool(
    {
      [PROVIDER]: {
        baseUrl: "https://api.example.com",
        keys: keys.map((k, i) => ({
          token: `sk-${i}`,
          label: `key-${i}`,
          priority: 1,
          weeklyBudget: k.weeklyBudget ?? Infinity,
          ...k,
        })),
      },
    },
    { stateFile: "", stateSaveIntervalMs: 0, ...opts }
  );
}

describe("KeyPool", () => {
  describe("pickKey", () => {
    it("picks from available keys / 從可用 key 中選取", () => {
      const pool = makePool([{}, {}]);
      const picked = pool.pickKey(PROVIDER);
      assert.ok(picked);
      assert.equal(picked.baseUrl, "https://api.example.com");
      assert.ok(picked.token.startsWith("sk-"));
    });

    it("returns null for nonexistent provider / 不存在的 provider 回傳 null", () => {
      const pool = makePool([{}]);
      assert.equal(pool.pickKey("nonexistent"), null);
    });
  });

  describe("reportFailure + cooldown", () => {
    it("key enters cooldown after failure / 失敗後 key 進入 cooldown", () => {
      const pool = makePool([{}], {
        cooldown: { defaultMs: 60_000 },
      });

      const picked = pool.pickKey(PROVIDER);
      pool.reportFailure(PROVIDER, picked.token, 400);

      assert.equal(pool.pickKey(PROVIDER), null);
    });

    it("429 has longer cooldown / 429 的 cooldown 較長", () => {
      const pool = makePool([{}], {
        cooldown: { "429Ms": 300_000 },
      });

      const picked = pool.pickKey(PROVIDER);
      pool.reportFailure(PROVIDER, picked.token, 429);

      const status = pool.getStatus(PROVIDER);
      assert.ok(status.keys[0].cooldownRemaining > 200);
    });

    it("can pick another key after one fails / 一把失敗後仍可選到另一把", () => {
      const pool = makePool([{}, {}], {
        cooldown: { defaultMs: 60_000 },
      });

      const first = pool.pickKey(PROVIDER);
      pool.reportFailure(PROVIDER, first.token, 500);

      const second = pool.pickKey(PROVIDER);
      assert.ok(second);
      assert.notEqual(second.token, first.token);
    });
  });

  describe("weekly quota / 週額度", () => {
    it("over-quota key is not picked / 超過週額度的 key 不被選取", () => {
      const pool = makePool([{ weeklyBudget: 1.0 }]);
      const picked = pool.pickKey(PROVIDER);

      pool.reportSuccess(PROVIDER, picked.token, 1.0);
      assert.equal(pool.pickKey(PROVIDER), null);
    });

    it("under-quota key is still available / 未超額的 key 仍可選取", () => {
      const pool = makePool([{ weeklyBudget: 5.0 }, { weeklyBudget: 5.0 }]);

      const first = pool.pickKey(PROVIDER);
      pool.reportSuccess(PROVIDER, first.token, 5.0);

      const second = pool.pickKey(PROVIDER);
      assert.ok(second);
      assert.notEqual(second.token, first.token);
    });
  });

  describe("getStatus", () => {
    it("returns correct status summary / 回傳正確的狀態摘要", () => {
      const pool = makePool([{ weeklyBudget: 10.0 }]);
      const status = pool.getStatus(PROVIDER);

      assert.equal(status.keys.length, 1);
      assert.equal(status.keys[0].available, true);
      assert.equal(status.keys[0].weeklyBudget, 10.0);
      assert.equal(status.keys[0].weeklySpent, 0);
    });
  });

  describe("notifications / 通知", () => {
    it("notifies when all keys unavailable / 全部 key 不可用時觸發通知", () => {
      const notifications = [];
      const pool = makePool([{}], {
        cooldown: { defaultMs: 60_000 },
        onNotify: (text) => notifications.push(text),
      });

      const picked = pool.pickKey(PROVIDER);
      pool.reportFailure(PROVIDER, picked.token, 500);

      assert.equal(notifications.length, 1);
      assert.ok(notifications[0].includes("unavailable"));
    });
  });
});
