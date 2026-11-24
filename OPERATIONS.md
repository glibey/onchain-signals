# onchain-signals: операційна документація (внутрішня, не публікується в npm)

Аналітика prediction markets для AI-агентів з оплатою за кожен запит.
Ключі API не потрібні: агент платить USDC через [x402](https://x402.org) прямо в HTTP-запиті.

## Ендпоінти

| Метод | Шлях | Ціна | Що повертає |
|---|---|---|---|
| GET | `/v1/markets/movers?window=1d\|1w&limit=&minVolume=` | $0.01 | ринки з найбільшими рухами ціни |
| GET | `/v1/whales?min=&limit=` | $0.02 | великі угоди + net-потік грошей китів по ринках |
| GET | `/v1/market/{slug}?min=` | $0.01 | ринок: ціни, спред, ліквідність, потік китів, сигнали |
| GET | `/`, `/.well-known/x402`, `/health` | free | каталог і ціни |

Без оплати платні ендпоінти відповідають `402 Payment Required` з інструкцією в заголовку `payment-required`.
x402-клієнт (наприклад `@x402/fetch`) платить автоматично і повторює запит.

## Запуск

```bash
npm install
cp .env.example .env   # впиши PAY_TO = адреса свого гаманця (не приватний ключ!)
npm run dev
```

Для локальної розробки без оплати: `X402_DISABLED=1 npm run dev`.

## Тест оплати (клієнт)

Клієнт у `src/client.ts` спершу показує ціну, перевіряє запобіжники, потім платить і виводить результат, посилання на транзакцію та баланс до і після.

1. Створи окремий тестовий гаманець-платника (лише для тесту, без реальних грошей):
   ```bash
   npm run wallet:new
   ```
   Встав виведений `CLIENT_PRIVATE_KEY` у `.env`.
2. Отримай тестові USDC на цю адресу: https://faucet.circle.com → Base Sepolia. Газ не потрібен, його платить фасилітатор.
3. В одному терміналі `npm run dev`, в іншому:
   ```bash
   npm run client -- "/v1/whales?min=20000"
   ```

Запобіжники: клієнт не платить більше `CLIENT_MAX_USD` (за замовчуванням $0.05) і відмовляється витрачати реальні USDC на mainnet без `CLIENT_ALLOW_MAINNET=1`.

## MCP-сервер (Claude, Cursor, будь-який агент)

`src/mcp.ts` — це локальний MCP-сервер. Агент викликає тули, а сервер сам платить нашому API через x402 з гаманця користувача.

| Тул | Ціна | Що робить |
|---|---|---|
| `get_market_movers` | $0.01 | найбільші рухи цін |
| `get_whale_trades` | $0.02 | великі угоди + потік грошей китів |
| `analyze_market` | $0.01 | розбір одного ринку (slug або посилання polymarket.com) |
| `list_services` | free | каталог і ціни |
| `wallet_status` | free | адреса, баланс USDC, витрати за сесію, чеки |

Запобіжники: `CLIENT_MAX_USD` (ліміт на один виклик, за замовчуванням $0.05), `CLIENT_SESSION_BUDGET_USD` (ліміт на сесію, за замовчуванням $1), без `CLIENT_ALLOW_MAINNET=1` реальні USDC не витрачаються.

**Claude Code:**
```bash
claude mcp add onchain-signals -e API_URL=http://localhost:4021 -e CLIENT_PRIVATE_KEY=0x... -- npx -y tsx /path/to/onchain-signals/src/mcp.ts
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` / `.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "onchain-signals": {
      "command": "npx",
      "args": ["-y", "tsx", "/path/to/onchain-signals/src/mcp.ts"],
      "env": {
        "API_URL": "http://localhost:4021",
        "CLIENT_PRIVATE_KEY": "0x...",
        "CLIENT_SESSION_BUDGET_USD": "1"
      }
    }
  }
}
```

MCP-сервер також читає `.env` проєкту, тому `CLIENT_PRIVATE_KEY` краще тримати там, а не в конфігу MCP-клієнта (значення з конфігу мають пріоритет). Цей ключ дає серверу право витрачати гроші, тому використовуй окремий гаманець з невеликим балансом.

## Надійність і облік

- **Без оплати за помилки:** якщо Polymarket недоступний або ринок не знайдено, API відповідає 5xx/404, і x402 не списує платіж. Це покрито тестами.
- **Кеш** відповідей Polymarket (`CACHE_TTL_MS`, 30 с за замовчуванням), таймаут 8 с і 2 повтори на 429/5xx.
- **Rate limit** на безкоштовні ендпоінти: `FREE_RATE_PER_MIN` (60 за замовчуванням) на IP.
- **Журнал платежів** у SQLite (`data/payments.db`, не в git). Звіт про виручку:
  ```bash
  npm run revenue              # усе
  npm run revenue -- 2026-11-01  # з дати
  ```
- **Тести:** `npm test` (vitest). Повний цикл оплати перевіряється справжнім x402-клієнтом проти фейкового фасилітатора.

## Віддалений MCP (`/mcp`)

Ті самі тули доступні по Streamable HTTP на `/mcp`, з оплатою x402 всередині MCP-виклику. Агентам з підтримкою x402 (наприклад, `createx402MCPClient` з `@x402/mcp`) нічого не треба встановлювати. У журнал такі оплати пишуться як `mcp://tool/<назва>`. Невдалий виклик (наприклад, неіснуючий ринок) не оплачується.

## Bazaar

Кожна 402-відповідь містить метадані Bazaar: приклади вхідних і вихідних даних, назву сервісу й теги. Фасилітатор CDP за ними автоматично вносить нас у каталог x402-сервісів, і агенти знаходять нас самі.

## Прод: AWS Lightsail

**Адреса:** https://13-49-215-169.sslip.io (тимчасова, поки немає свого домену). **Мережа: Base mainnet, справжні USDC.**

Сервер `onchain-signals`: Lightsail `micro_3_0` (1 GB, $7 на місяць), `eu-north-1`, Ubuntu 24.04, статична IP 13.49.215.169. Він окремий від `polymarket`, бо там live-бот із гаманцем. Відкриті порти 22, 80 і 443. Caddy робить HTTPS з автоматичним сертифікатом і проксує на `127.0.0.1:4021`, де працює Docker-контейнер. Журнал платежів лежить у `/srv/onchain-signals/data`, конфіг — у `/srv/onchain-signals/.env`.

Адресу сервера і ключ скрипт бере з локального `.env` (`PROD_HOST`, `PROD_SSH_KEY`, `PROD_DOMAIN`). SSH-ключ `~/.ssh/onchain_signals_lightsail` є тільки на цьому Mac.

| Команда | Що робить |
|---|---|
| `npm run prod deploy` | Тести, збірка образу (linux/amd64), завантаження, рестарт, перевірка health |
| `npm run prod env` | Редагувати серверний `.env`, після виходу рестарт |
| `npm run prod restart` | Перестворити контейнер (щоб підхопився новий `.env`) |
| `npm run prod logs` | Логи в реальному часі |
| `npm run prod status` | Контейнер, пам'ять, диск, health |
| `npm run prod revenue` | Звіт про виручку з прод-журналу |
| `npm run prod caddy` | Переналаштувати HTTPS для `PROD_DOMAIN` |
| `npm run prod ssh` | Зайти на сервер |

Новий сервер з нуля: `deploy/user-data.sh` (swap, Docker, Caddy, автооновлення). Запуск: `ssh … 'sudo bash -s' < deploy/user-data.sh`. Альтернатива — Fly.io: `fly.toml` у репозиторії.

**Mainnet (з 24.11.2026):** прод працює на Base mainnet (`NETWORK=eip155:8453`) через фасилітатор PayAI (`FACILITATOR_URL=https://facilitator.payai.network`). Ключі не потрібні, газ платить PayAI. Комісія на Base $0.0015 за платіж (EIP-3009), безкоштовних кредитів приблизно на 763 платежі, далі треба купувати кредити в акаунті PayAI. Тестова конфігурація збережена на сервері в `/srv/onchain-signals/.env.testnet.bak`. Альтернатива — Coinbase CDP (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`; спершу `npm i @coinbase/x402`, бо цей пакет прибрано із залежностей через вразливий zod 3).

## npm (`npx onchain-signals-mcp`)

Пакет збирається в `dist/`, бінарник `onchain-signals-mcp` — це локальний MCP-міст. Після деплою в `API_URL` треба вказати публічну адресу. Публікація: `npm publish` (перед нею автоматично проходять збірка й тести). Для офіційного MCP Registry: `mcp-publisher init` → `mcp-publisher publish`.

## Мережі

- **Тест:** `NETWORK=eip155:84532` (Base Sepolia), безкоштовний фасилітатор `https://x402.org/facilitator`. Тестові USDC беруться з крану Circle.
- **Прод:** `NETWORK=eip155:8453` (Base mainnet) + фасилітатор Coinbase CDP (потрібні CDP-ключі).

## Дорожня карта

1. ~~MCP-сервер~~ ✅ ~~віддалений MCP, Bazaar, Docker/Fly, npm-пакет~~ ✅ далі: деплой, mainnet, публікація в npm і реєстрах.
2. Реєстрація в Bazaar (каталог x402-сервісів) через `@x402/extensions/bazaar`.
3. Smart-money сигнали on-chain (кити на DEX, нові токени) із smart-money-tracker.
4. Кеш + історія, щоб продавати тренди, а не лише знімки.
5. Деплой (Cloudflare Workers / Fly) і Solana як друга мережа оплати.

## Публікація (npm + MCP Registry)

Публічний README для npm англійською — `README.md`. Цей файл (`OPERATIONS.md`) у пакет не потрапляє. Адреса проду за замовчуванням — `DEFAULT_API_URL` у `src/mcp.ts`; якщо зміниться домен, онови її і `server.json` (remotes) і підніми версію.

```bash
npm login
npm publish                    # перед публікацією: tsc + тести
mcp-publisher login github     # акаунт glibey → namespace io.github.glibey
mcp-publisher publish          # server.json; версія = версії в package.json
```
