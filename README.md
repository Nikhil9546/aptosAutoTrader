# Teletrade Bot (Minimal Single-File)

## Setup
1) `npm i`
2) `cp .env.example .env` and fill `BOT_TOKEN`, `TELETRADE_PUBLISHER`, `ADMIN_PRIVATE_KEY`
3) `npm start`

## Commands
- `/start` – health + addresses
- `/link_agent 0x<agent>` – calls `agent_registry::link_user`
- `/leverage <u64>` – calls `agent_registry::set_user_leverage`
- `/signal BTC LONG 0.25 5` – AES-GCM encrypts a small payload and posts to `signal_vault::post_signal`
