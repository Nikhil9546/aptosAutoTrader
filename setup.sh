# === create structure ===
mkdir -p docs \
  contracts/teletrade/sources \
  apps/bot/src \
  apps/signal-ingestor/src \
  apps/signer-stub/src \
  apps/watcher/src \
  packages/shared/src \
  packages/sdk-aptos/src \
  db/migrations \
  scripts

# --- docs placeholders ---
cat > docs/ARCHITECTURE.md <<'EOF'
# Architecture
High-level overview for the Telegram trading kit (bot, ingestor, signer-stub, watcher) + Move modules.
EOF
cat > docs/MOVE.md <<'EOF'
# Move Modules
AgentRegistry, SignalVault, EventRegistry, (optional) Router. See contracts/teletrade/sources.
EOF
cat > docs/CRYPTO.md <<'EOF'
# Crypto
Off-chain AES-256-GCM for signals & keystore; SHA3-256 for payload_hash; Argon2id for key derivation.
EOF
cat > docs/API.md <<'EOF'
# APIs
Internal contracts between services. Define later as you wire real endpoints.
EOF

# --- Move package config ---
cat > contracts/teletrade/Move.toml <<'EOF'
[package]
name = "teletrade"
version = "0.0.1"
upgrade_policy = "immutable"

[addresses]
# This placeholder is resolved at publish time:
teletrade = "_"
aptos_framework = "0x1"

[dependencies]
AptosFramework = { git = "https://github.com/aptos-labs/aptos-core.git", subdir = "aptos-move/framework/aptos-framework", rev = "mainnet" }
EOF

# --- agent_registry.move ---
cat > contracts/teletrade/sources/agent_registry.move <<'EOF'
module teletrade::agent_registry {
    use std::signer;
    use aptos_std::event;

    const MODE_MANUAL: u8 = 0;
    const MODE_AUTO: u8 = 1;

    struct Agent has key {
        pubkey: vector<u8>,
        max_leverage: u64,
        metadata: vector<u8>,
    }

    struct UserConfig has key {
        agent: address,
        leverage: u64,
        mode: u8, // 0 = manual, 1 = auto
    }

    struct AgentRegistered has drop, store { agent: address, max_leverage: u64 }
    struct UserLinked      has drop, store { user: address, agent: address }
    struct LeverageUpdated has drop, store { user: address, leverage: u64 }
    struct ModeUpdated     has drop, store { user: address, mode: u8 }

    public entry fun register_agent(
        account: &signer,
        pubkey: vector<u8>,
        max_leverage: u64,
        metadata: vector<u8>
    ) {
        let addr = signer::address_of(account);
        assert!(!exists<Agent>(addr), 100);
        move_to<Agent>(account, Agent { pubkey, max_leverage, metadata });
        event::emit<AgentRegistered>(AgentRegistered { agent: addr, max_leverage });
    }

    public entry fun link_user(account: &signer, agent_addr: address) {
        let user = signer::address_of(account);
        assert!(exists<Agent>(agent_addr), 101);
        if (!exists<UserConfig>(user)) {
            move_to<UserConfig>(account, UserConfig { agent: agent_addr, leverage: 1, mode: MODE_MANUAL });
        } else {
            let c = borrow_global_mut<UserConfig>(user);
            c.agent = agent_addr;
        };
        event::emit<UserLinked>(UserLinked { user, agent: agent_addr });
    }

    public entry fun set_user_leverage(account: &signer, leverage: u64) {
        let user = signer::address_of(account);
        if (!exists<UserConfig>(user)) {
            move_to<UserConfig>(account, UserConfig { agent: @0x0, leverage, mode: MODE_MANUAL });
        } else {
            let c = borrow_global_mut<UserConfig>(user);
            if (exists<Agent>(c.agent)) {
                let a = borrow_global<Agent>(c.agent);
                assert!(leverage <= a.max_leverage, 103);
            };
            c.leverage = leverage;
        };
        event::emit<LeverageUpdated>(LeverageUpdated { user, leverage });
    }

    public entry fun set_user_mode(account: &signer, mode: u8) {
        let user = signer::address_of(account);
        assert!(mode == MODE_MANUAL || mode == MODE_AUTO, 104);
        if (!exists<UserConfig>(user)) {
            move_to<UserConfig>(account, UserConfig { agent: @0x0, leverage: 1, mode });
        } else {
            let c = borrow_global_mut<UserConfig>(user);
            c.mode = mode;
        };
        event::emit<ModeUpdated>(ModeUpdated { user, mode });
    }

    public fun get_user_config(user: address): (address, u64, u8) acquires UserConfig {
        let c = borrow_global<UserConfig>(user);
        (c.agent, c.leverage, c.mode)
    }

    public fun is_agent(addr: address): bool acquires Agent { exists<Agent>(addr) }
}
EOF

# --- signal_vault.move ---
cat > contracts/teletrade/sources/signal_vault.move <<'EOF'
module teletrade::signal_vault {
    use std::signer;
    use std::vector;
    use aptos_std::event;
    use teletrade::agent_registry;

    struct EncryptedSignal has store {
        agent: address,
        user: address,
        hash: vector<u8>,
        blob: vector<u8>,
        iv: vector<u8>,
        aad: vector<u8>,
        tag: vector<u8>,
        ts: u64,
    }

    struct SignalPosted has drop, store { agent: address, user: address, hash: vector<u8>, ts: u64 }

    struct UserSignals has key { signals: vector<EncryptedSignal> }

    public entry fun post_signal(
        account: &signer,
        agent: address,
        hash: vector<u8>,
        blob: vector<u8>,
        iv: vector<u8>,
        aad: vector<u8>,
        tag: vector<u8>,
        ts: u64
    ) acquires UserSignals {
        let user = signer::address_of(account);
        let (linked_agent, _lev, _mode) = agent_registry::get_user_config(user);
        assert!(linked_agent == agent, 200);

        if (!exists<UserSignals>(user)) {
            move_to<UserSignals>(account, UserSignals { signals: vector::empty<EncryptedSignal>() });
        };

        let hash_copy = vector::clone(&hash);
        let sref = borrow_global_mut<UserSignals>(user);
        vector::push_back(&mut sref.signals, EncryptedSignal { agent, user, hash, blob, iv, aad, tag, ts });

        event::emit<SignalPosted>(SignalPosted { agent, user, hash: hash_copy, ts });
    }

    public fun count(user: address): u64 acquires UserSignals {
        if (!exists<UserSignals>(user)) { 0 } else {
            let s = borrow_global<UserSignals>(user);
            vector::length(&s.signals)
        }
    }
}
EOF

# --- event_registry.move ---
cat > contracts/teletrade/sources/event_registry.move <<'EOF'
module teletrade::event_registry {
    use std::signer;
    use aptos_std::event;

    const E_NOT_AUTH: u64 = 300;

    fun assert_admin(s: &signer) { assert!(signer::address_of(s) == @teletrade, E_NOT_AUTH); }

    struct OrderRouted has drop, store { user: address, venue: vector<u8>, client_id: vector<u8> }
    struct TradeExecuted has drop, store { user: address, venue: vector<u8>, fill_sz: u128, price: u128, pnl: i128, ts: u64 }

    public entry fun emit_order_routed(admin: &signer, user: address, venue: vector<u8>, client_id: vector<u8>) {
        assert_admin(admin);
        event::emit<OrderRouted>(OrderRouted { user, venue, client_id });
    }

    public entry fun emit_trade_executed(
        admin: &signer, user: address, venue: vector<u8>, fill_sz: u128, price: u128, pnl: i128, ts: u64
    ) {
        assert_admin(admin);
        event::emit<TradeExecuted>(TradeExecuted { user, venue, fill_sz, price, pnl, ts });
    }
}
EOF

# --- optional router stub ---
cat > contracts/teletrade/sources/router.move <<'EOF'
module teletrade::router {
    public entry fun noop() {}
}
EOF

# --- TS stubs (no deps) ---
cat > apps/bot/src/index.ts <<'EOF'
/**
 * Bot stub (no external deps). Replace with Telegraf later.
 */
const PORT = process.env.PORT || '7071';
console.log('[bot] starting stub…');
console.log('Expected commands: /start, /signal, /leverage, /portfolio, /mode');
console.log('Wire real Telegram bot later (telegraf).');
console.log(`[bot] up (stub). PORT=${PORT}`);
EOF

cat > apps/signal-ingestor/src/index.ts <<'EOF'
/**
 * Signal ingestor stub.
 * Replace with real connectors; for now it just logs a tick every 10s.
 */
console.log('[ingestor] starting stub…');
setInterval(() => console.log('[ingestor] tick – would fetch/generate signals'), 10_000);
EOF

cat > apps/signer-stub/src/index.ts <<'EOF'
/**
 * Signer stub: no HTTP framework required; just prints how it would process.
 */
console.log('[signer] starting stub…');
console.log('[signer] would: read SignalPosted -> decrypt -> policy -> route to Merkel -> emit events');
EOF

cat > apps/watcher/src/index.ts <<'EOF'
/**
 * Watcher stub: pretend to subscribe to on-chain events and notify bot.
 */
console.log('[watcher] starting stub…');
console.log('[watcher] would listen to SignalPosted, OrderRouted, TradeExecuted');
EOF

# --- shared types ---
cat > packages/shared/src/types.ts <<'EOF'
export type Side = 'LONG' | 'SHORT';

export interface OrderIntent {
  symbol: string;
  side: Side;
  orderType: 'MARKET' | 'LIMIT';
  quantity: string; // decimal as string
  price?: string;
  leverage: number;
  clientId: string; // nonce/ulid
}

export interface EncryptedSignal {
  version: '1';
  strategy_id: string;
  user: string; // 0x…
  ts: number;
  payload: {
    symbol: string;
    side: Side;
    qty: number;
    tp?: number;
    sl?: number;
    leverage?: number;
  };
  cipher: {
    alg: 'AES-256-GCM';
    iv: string;       // base64 12B
    aad: string;      // base64
    ciphertext: string;
    tag: string;      // base64
  };
  payload_hash: string; // sha3-256-hex
  nonce: string;        // ulid
}
EOF

# --- sdk-aptos placeholder (no @aptos-labs dep yet) ---
cat > packages/sdk-aptos/src/client.ts <<'EOF'
/**
 * Placeholder for Aptos SDK wrapper.
 * Later: import { Aptos, AptosConfig, Network } from "@aptos-labs/ts-sdk";
 */
export class AptosClientPlaceholder {
  constructor(readonly network: 'TESTNET'|'DEVNET'|'LOCAL'='TESTNET') {}
  async publishInfo() { return { network: this.network, ok: true }; }
}
EOF

# --- db placeholders ---
cat > db/README.md <<'EOF'
# DB
Plan: users, wallets (encrypted), signals index, orders, positions.
EOF
touch db/migrations/.keep

# --- scripts placeholders ---
cat > scripts/publish_move.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../contracts/teletrade"
echo "Publishing Move package…"
echo "Make sure 'aptos' CLI is installed and 'teletrade-testnet' profile exists."
echo "Command:"
echo 'aptos move publish --profile teletrade-testnet --named-addresses teletrade=0x<YOUR_ACCOUNT_ADDRESS>'
EOF
chmod +x scripts/publish_move.sh

echo "✅ Done. Created contracts, docs, apps stubs, packages, db, scripts."

