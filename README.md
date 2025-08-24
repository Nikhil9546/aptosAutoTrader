# AptosTrader Bot — README (Testnet)

A Telegram bot that:

* Creates a paper-trading wallet per Telegram user (no UI changes needed).
* Listens to an external signal feed and **auto-opens/ closes paper positions** based on your size and leverage.
* **Posts each new signal on-chain** to your Move contracts (admin only by default; optional per-user posting).
* Provides quick portfolio readouts and simple risk/size controls via Telegram keyboard.

---

## Deployed Contracts (Testnet)

* **Package / Module address**:
  `0xc15ccf35138f0f6ca4c498d3c17f80e3497bd9b150b0c126f02b326eb05b7255`

* **Explore on Aptos Explorer (Testnet):**

  * Account:
    `https://explorer.aptoslabs.com/account/0xc15ccf35138f0f6ca4c498d3c17f80e3497bd9b150b0c126f02b326eb05b7255?network=testnet`
  * Modules (tab) → `teletrade::agent_registry`, `teletrade::signal_vault`
  * **To see user changes**: open the *Resources* tab of a **user address**, look for
    `…::signal_vault::UserSignals` and `…::agent_registry::UserConfig`.
  * **To see events**: open the *Events* tab and filter for `SignalPosted` or `AgentRegistered`.

> Tip: paste any user address from the bot into Explorer to see that user’s `UserSignals` count grow as signals are posted.

---

## What you need

* Node.js 18+ and npm/yarn/pnpm
* Telegram bot token (via @BotFather)
* An Aptos **testnet** private key (ed25519) with some test APT (the bot will faucet-fund new users automatically)

---

## 1) Clone & Install

```bash
git clone <your-repo>
cd aptosAutoTrader
npm i
```

---

## 2) Configure `.env`

Create a `.env` file in the project root:

```env
# Telegram
BOT_TOKEN=123456789:xxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Aptos
APTOS_NETWORK=testnet
APTOS_FULLNODE_URL=https://fullnode.testnet.aptoslabs.com/v1
APTOS_FAUCET_URL=https://faucet.testnet.aptoslabs.com

# Admin key (AIP-80 format recommended)
# Accepts "ed25519-priv-0x..." or "0x..." 32-byte private key
ADMIN_PRIVATE_KEY=ed25519-priv-0xyourkeyhere

# Contracts
MODULE_ADDR=0xc15ccf35138f0f6ca4c498d3c17f80e3497bd9b150b0c126f02b326eb05b7255

# Signals
SIGNAL_FEED_URL=http://34.67.134.209:5000/today
SIGNAL_POLL_MS=60000

# Paper trading defaults
PAPER_START_USDC=10000
DEFAULT_RISK=5

# Optional: control on-chain posting scope: admin | users | both  (default: admin)
POST_ONCHAIN_SCOPE=admin

# Optional: fixed encryption key for signal payloads (32 bytes hex).
# If omitted, it’s derived from ADMIN_PRIVATE_KEY.
# SIGNAL_KEY_HEX=0x1111111111111111111111111111111111111111111111111111111111111111
```

**Key format tip (AIP-80):** If you see SDK warnings, convert your key:

```js
PrivateKey.formatPrivateKey('0x<raw-hex>', 'ed25519');   // outputs "ed25519-priv-0x..."
```

---

## 3) Run the bot

```bash
npm start
```

Open your Telegram bot and send `/start`.

---

## 4) Onboarding Flow (what happens)

* **/start**

  * If you’re new: the bot generates a user wallet, stores it in `users.json`, and **requests faucet** funds on testnet once.
  * Shows your wallet address and the keyboard menu (UI stays exactly as in the code).
* **Signal polling**

  * The bot polls `SIGNAL_FEED_URL` every `SIGNAL_POLL_MS` ms.
  * On each **new** signal:

    * Posts the encrypted signal **on-chain** (admin by default; optionally per-user if `POST_ONCHAIN_SCOPE=users|both`).
    * If your **auto** is ON **and** you set a **size** (25% or 50%), the bot:

      * Closes opposite positions in paper.
      * Opens a new paper position using your leverage (`/riskfactor`).
      * Updates your paper balance accordingly.
* **No manual “register agent” or “link user” steps in the UI.** If your Move `post_signal` requires a linked agent/user, prepare that once via CLI (see below) or wire auto-link in code if needed.

---

## 5) Commands (UI unchanged)

* `/portfolio` — APT balance, paper USDC, open positions, est. P\&L, latest signal
* `/riskfactor` — set leverage (or tap quick buttons)
* `/size` — choose 25% or 50% per-signal allocation
* `/stop` — turn off auto paper trading
* `/closeall` — close all paper positions
* `/monitor` — toggle signal monitoring notifications
* `/ping` — health check

> Optional (if you added it): `/onsignals` shows on-chain signal counts for you and for admin.

---

## 6) How paper trading works

* Each user starts with `PAPER_START_USDC`.
* **LONG** signal: opens a long position (collateral = allocation × current paper balance).
* **SHORT** signal: closes longs in that symbol, then opens a short (same sizing rule).
* P\&L = notional × % change, where notional = collateral × leverage.
* Closing a position returns collateral ± P\&L to your paper balance.

---

## 7) How on-chain posting works

* For each new feed signal, the bot:

  * Encrypts the payload (AES-GCM). Key is either `SIGNAL_KEY_HEX` or derived from `ADMIN_PRIVATE_KEY`.
  * Calls `signal_vault::post_signal(...)` with `(agent, hash, blob, iv, aad, tag, ts)`.
  * **Scope**:

    * `POST_ONCHAIN_SCOPE=admin` → Admin’s account posts (ledger of record).
    * `POST_ONCHAIN_SCOPE=users` → Each user posts into their own `UserSignals` (requires gas + agent/user config).
    * `POST_ONCHAIN_SCOPE=both` → Both behaviors.

You’ll see `SignalPosted` events on Explorer and `UserSignals` resource count increment on the user account(s).

---

## 8) (If required) One-time on-chain setup via CLI

If your `post_signal` gate checks `agent_registry::get_user_config`, do this once:

**Register agent (admin runs this once):**

```bash
aptos move run \
  --function-id 0xc15c...b7255::agent_registry::register_agent \
  --args hex:0x00 u64:10 hex:0x  \
  --profile default --network testnet
```

* `pubkey`: `0x00` (stub)
* `max_leverage`: `10` (choose your policy)
* `metadata`: `0x` (empty)

**Each user links to the agent (can be done by user account once):**

```bash
aptos move run \
  --function-id 0xc15c...b7255::agent_registry::link_user \
  --args address:0x<admin_address> \
  --profile <user_profile> --network testnet
```

> If you see **Move abort 0x65** while linking/posting, it usually means the agent isn’t registered yet or the user isn’t linked.

---

## 9) Where to see changes on Explorer

* **Admin / User signals (resource):**
  Open the user’s account → **Resources** →
  `0xc15c…b7255::signal_vault::UserSignals`
  *The `signals` vector length increases with each post.*

* **User config:**
  `0xc15c…b7255::agent_registry::UserConfig` on the user account shows `agent`, `leverage`, `mode`.

* **Events:**

  * `teletrade::signal_vault::SignalPosted`
  * `teletrade::agent_registry::AgentRegistered`, `UserLinked`, `LeverageUpdated`, `ModeUpdated`

---

## 10) Troubleshooting

* **Faucet issues / 0 balance**

  * The bot calls `POST /mint` on the faucet for new users. If faucet is rate-limited, wait and try `/start` again or run:

    ```
    curl -s -X POST \
      -H "Content-Type: application/json" \
      -d '{"address":"<addr-without-0x>","amount":5000000}' \
      https://faucet.testnet.aptoslabs.com/mint
    ```


---

## 11) Files to know

* `bot.mjs` — the Telegram bot (paper engine, signal polling, on-chain posting)
* `users.json` — per-Telegram user wallets & state (address, private key string, paper balance, positions, etc.)
* `state.json` — last processed feed key (prevents duplicate actions)

---

## 12) Security

* This is a **testnet**/demo bot. It stores user private keys locally in `users.json`.
  Do **not** use mainnet funds with this setup.

---

That’s it. Launch the bot, tap `/start`, set `/size` and `/riskfactor`, and watch your **paper portfolio** and **on-chain `UserSignals`** update as new signals arrive.

