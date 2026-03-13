# llm-key-router

輕量級 LLM API Key 管理代理 — key 池管理、自動 failover、配額追蹤。

## 功能

- **Key 池**：每個 provider 支援多把 key，隨機選取避免碰撞
- **自動 Failover**：任何失敗即換 key 重試，全部耗盡才回 503
- **冷卻機制**：依錯誤類型（429 / 5xx / timeout）設定不同冷卻時間
- **週額度**：per-key 週預算，90% 警告，每週一自動重置
- **狀態持久化**：JSON 檔，重啟不遺失
- **Telegram 通知**：key 切換、全部耗盡時推送

## 環境需求

- Node.js >= 18
- 零外部依賴（僅使用 Node.js 內建模組）

## 快速開始

```bash
# 1. 複製並編輯設定檔
cp config.example.json config.json
cp keys.example.json keys.json
# 編輯 keys.json 填入實際 API key

# 2. 啟動
node src/index.js
```

## 使用方式

代理預設監聽 `http://127.0.0.1:4000`。將 provider 名稱加在路徑前即可路由請求：

```bash
# 透過 proxy 發送請求
curl http://127.0.0.1:4000/ollama-cloud/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "llama3", "messages": [{"role": "user", "content": "hello"}]}'

# 查看所有 key 狀態
curl http://127.0.0.1:4000/status

# 健康檢查
curl http://127.0.0.1:4000/health
```

## 設定

### config.json

| 欄位 | 說明 | 預設值 |
|---|---|---|
| `port` | 監聽埠 | `4000` |
| `keysFile` | key 檔路徑 | `./keys.json` |
| `stateFile` | 狀態檔路徑 | `./data/state.json` |
| `cooldown.429Ms` | 429 冷卻時間 | `300000` (5分鐘) |
| `cooldown.5xxMs` | 5xx 冷卻時間 | `30000` (30秒) |
| `cooldown.timeoutMs` | 逾時冷卻時間 | `15000` (15秒) |
| `cooldown.defaultMs` | 預設冷卻時間 | `60000` (1分鐘) |
| `request.timeoutMs` | 上游請求逾時 | `120000` (2分鐘) |
| `telegram.botToken` | Telegram Bot Token | `""` |
| `telegram.chatId` | Telegram Chat ID | `""` |

### keys.json

```json
{
  "providers": {
    "provider-name": {
      "baseUrl": "https://api.example.com",
      "keys": [
        {
          "token": "sk-xxx",
          "label": "描述性標籤",
          "weeklyBudget": 5.00,
          "priority": 1
        }
      ]
    }
  }
}
```

## Key 遷移

如果已有既有的 key 檔案，可用遷移腳本轉換：

```bash
node src/migrate-keys.js
# 或指定自訂路徑
node src/migrate-keys.js --ollama /path/to/ollama_keys.json --gemini /path/to/gemini_keys.json
```

## 測試

```bash
node --test src/**/*.test.js
```

## 授權

[MIT](LICENSE)
