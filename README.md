# Aptos AutoTrader — Encrypted Signal Trading via Telegram + Aptos + Merkel Trade

> Single-repo blueprint for a Telegram trading app that accepts **manual** and **automated** signals, **encrypts** them, routes orders to **Merkel Trade**, and records lifecycle events on **Aptos**. Move contracts handle registries and eventing; a signer service (stub now, **TEE later**) performs decryption + policy checks + execution.

## Identified Problem (Onboarding Friction)

A large share of retail and institutional traders want autonomous leveraged trading, but onboarding stalls for two reasons: (1) secure wallet automation for decentralized execution is hard—users don’t trust bots that can sign on their behalf; and (2) signal quality is inconsistent or opaque, so traders hesitate to connect real capital.

## Proposed Solution — Aptos AutoTrader

> Aptos Autopilot is an AI-driven trading kit that runs on Aptos L1 and pairs advanced ML signals with secure transaction automation. Signals are encrypted end-to-end, stored on-chain, and executed by a signer service that is stubbed today and upgradeable to a TEE (Trusted Execution Environment) tomorrow. The system integrates natively with the Aptos TypeScript SDK and routes trades through the Merkle Trade SDK for seamless, decentralized leveraged execution.
---

## TL;DR

* `/start` → user gets an **Aptos wallet** and the bot starts watching their activity.
* Signals come from **/signal** (manual) or **ingestor** (automated).
* Signals are **AES-256-GCM encrypted** off-chain and stored in `SignalVault` (Move).
* A **signer** (stub for now) **decrypts → checks risk/policy → places order** on **Merkel Trade** → posts receipts/events.
* `/portfolio` aggregates venue positions + on-chain events; `/leverage` sets per-user leverage caps.
* Contracts: `AgentRegistry`, `EventRegistry`, `SignalVault` (+ optional `Router`).

---

## Why this exists

1. Keep signals private end-to-end (encrypt at source).
2. Separate **decision** (strategy) from **authority** (signer + policy).
3. Record an auditable trail of **who** did **what** and **when** on chain.
4. Upgrade path to **TEE** signing without changing upstream producers.

---

**Core flows**

* **Manual**: `/signal` → encrypt → `SignalVault.post_signal` → `EventRegistry.SignalPosted` → signer consumes → execute → `OrderRouted/TradeExecuted` → bot notifies.
* **Automated**: ingestor performs same encrypt+post; rest identical.

---

## Features

* **Aptos wallet on onboarding** (`/start`) with encrypted key storage.
* **Manual & automated signals** with **client-side encryption**.
* **Per-user leverage + policy caps** managed via `AgentRegistry`.
* **Order routing to Merkel Trade** (adapter), receipts captured.
* **On-chain event log** for auditability (`EventRegistry`).
* **Portfolio & PnL view** aggregated from venue + chain (`/portfolio`).
* **Migrate signer to TEE** without changing producers/consumers.

---

## On-Chain (Move) Modules

### `AgentRegistry`

* Register agents (public keys/metadata, max leverage).
* Link users to agents; set **per-user leverage**.
* **Events**: `AgentRegistered`, `UserLinked`, `LeverageUpdated`.

### `SignalVault`

* Store **encrypted signals** as `vector<u8>` + `iv`, `aad`, `tag`, `hash`, `ts`.
* Access control: only registered agent/user pairs may post/read metadata.
* **Event**: `SignalPosted { agent, user, hash, ts }`.

### `EventRegistry`

* Canonical lifecycle events:

  * `OrderRouted { user, venue, client_id }`
  * `TradeExecuted { user, venue, size, price, pnl }`

*(Optional) `Router` if you later execute on-chain venues.*

---

## Off-Chain Services

* **Bot**: Telegram commands, wallet creation, encryption of manual signals, leverage/mode management, notifications.
* **Signal Ingestor**: pulls from models/feeds; encrypts and posts to `SignalVault`.
* **Signer (Stub → TEE)**: consumes `SignalPosted`, decrypts (agent key), **policy checks**, routes order to Merkel Trade, emits receipts/events.
* **Watcher**: listens to Aptos events & polls venue; updates portfolio cache and notifies bot.

---

## Data Contracts

### Encrypted Signal (off-chain JSON before posting to chain)

```json
{
  "version": "1",
  "strategy_id": "strat_001",
  "user": "0xUSER",
  "ts": 1724392034,
  "payload": { "symbol":"BTC", "side":"LONG", "qty":0.5, "tp":116000, "sl":108000, "leverage":10 },
  "cipher": {
    "alg":"AES-256-GCM",
    "iv":"base64-12b",
    "aad":"base64",
    "ciphertext":"base64",
    "tag":"base64"
  },
  "payload_hash":"sha3-256-hex",
  "nonce":"ulid"
}
```

### Venue-Agnostic Order Intent

```json
{
  "symbol":"BTC",
  "side":"LONG|SHORT",
  "orderType":"MARKET|LIMIT",
  "quantity":"decimal",
  "price":"optional",
  "leverage":10,
  "clientId":"nonce"
}
```

---

## Security Model (Now vs Later)

**Now (Stub)**

* **AES-256-GCM** for signal encryption; random 12-byte IV; include **AAD**.
* User private keys encrypted at rest with **AES-256-GCM**; key derived via **Argon2id** from a user PIN/secret.
* Signer decrypts only when **policy checks** pass (max leverage, notional caps, per-user mode).

**Later (TEE)**

* Move signer into **SGX/TDX/ROFL**; require **remote attestation** before decrypting.
* Unseal agent keys inside enclave; same HTTP/queue contract, no producer changes.
* Emit attestation metadata alongside `OrderRouted`.

---

## Telegram Commands (MVP)

* `/start` — create Aptos wallet, show address, begin event subscription.
* `/signal <symbol> <LONG|SHORT> <qty> [x<lev>] [tp=..] [sl=..]` — encrypt & post.
* `/leverage <n>` — set per-user leverage on chain.
* `/portfolio` — positions + invested amount + recent PnL.
* `/mode <auto|manual>` — toggle strategy execution mode.

---

## Repository Layout

```
aptos-teletrade/
├── docs/                      # Architecture, Move specs, crypto notes, APIs
├── contracts/teletrade/       # Move sources (AgentRegistry, SignalVault, EventRegistry, Router)
├── apps/
│   ├── bot/                   # Telegram interface
│   ├── signal-ingestor/       # Automated signal producers
│   ├── signer-stub/           # Decrypt + policy + route (TEE later)
│   └── watcher/               # Event/position sync + notifications
├── packages/
│   ├── shared/                # Shared types/schemas
│   └── sdk-aptos/             # Thin client for our Move modules
├── db/                        # Schema/migrations for users, wallets, signals, orders, positions
└── scripts/                   # Devnet/publish/seed helpers
```


## First Implementation Checklist

* [ ] Fill Move module stubs; run unit tests; publish to Aptos testnet.
* [ ] Implement bot `/start` with keystore (Argon2id + AES-GCM).
* [ ] Implement `post_signal` path (manual + ingestor).
* [ ] Build signer (decrypt→policy→adapter) with dry-run; then enable live routing.
* [ ] Build watcher + `/portfolio` view.
* [ ] Add basic CI (lint, Move tests, TS tests) and E2E smoke.

