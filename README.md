# llm-key-router

Lightweight LLM API Key management proxy — key pool, auto failover, quota tracking.

## Features

- **Key pool**: manage multiple keys per provider, random selection to avoid collision
- **Auto failover**: retry with next key on any failure, return 503 only when all exhausted
- **Cooldown**: configurable per error type (429 / 5xx / timeout)
- **Weekly quota**: per-key budget with 90% warning, auto-reset every Monday
- **State persistence**: JSON file, survives restart
- **Telegram notifications**: push on key switch or all-exhausted

## Requirements

- Node.js >= 18
- Zero dependencies (stdlib only)

## Quick Start

```bash
# 1. Copy and edit config files
cp config.example.json config.json
cp keys.example.json keys.json
# Edit keys.json with your actual API keys

# 2. Start
node src/index.js
```

## Usage

The proxy listens on `http://127.0.0.1:4000` by default. Route requests by prepending the provider name to the path:

```bash
# Send request through proxy
curl http://127.0.0.1:4000/ollama-cloud/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "llama3", "messages": [{"role": "user", "content": "hello"}]}'

# Check status of all keys
curl http://127.0.0.1:4000/status

# Health check
curl http://127.0.0.1:4000/health
```

## Configuration

### config.json

| Field | Description | Default |
|---|---|---|
| `port` | Listen port | `4000` |
| `keysFile` | Path to keys file | `./keys.json` |
| `stateFile` | Path to state file | `./data/state.json` |
| `cooldown.429Ms` | Cooldown for rate limit | `300000` (5min) |
| `cooldown.5xxMs` | Cooldown for server error | `30000` (30s) |
| `cooldown.timeoutMs` | Cooldown for timeout | `15000` (15s) |
| `cooldown.defaultMs` | Default cooldown | `60000` (1min) |
| `request.timeoutMs` | Upstream request timeout | `120000` (2min) |
| `telegram.botToken` | Telegram bot token | `""` |
| `telegram.chatId` | Telegram chat ID | `""` |

### keys.json

```json
{
  "providers": {
    "provider-name": {
      "baseUrl": "https://api.example.com",
      "keys": [
        {
          "token": "sk-xxx",
          "label": "descriptive label",
          "weeklyBudget": 5.00,
          "priority": 1
        }
      ]
    }
  }
}
```

## Key Migration

If you have existing key files, use the migration script to convert them:

```bash
node src/migrate-keys.js
# or with custom paths
node src/migrate-keys.js --ollama /path/to/ollama_keys.json --gemini /path/to/gemini_keys.json
```

## Testing

```bash
node --test src/**/*.test.js
```

## License

[MIT](LICENSE)
