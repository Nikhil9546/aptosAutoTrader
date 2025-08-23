# at: aptosAutoTrader/
cat > reset-min.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

STAMP="_backup_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$STAMP"

echo "==> Backing up old folders to $STAMP/"
for p in apps packages scripts db docs node_modules package-lock.json tsconfig.json setup.sh; do
  [ -e "$p" ] && { echo " -> $p"; mv "$p" "$STAMP/"; }
done
if [ -e package.json ]; then
  echo " -> package.json"
  mv package.json "$STAMP/package.json.bak"
fi

# NOTE: contracts/ is kept in place on purpose. If you also want it backed up:
# mv contracts "$STAMP/" && echo " -> contracts (backed up)"

echo "==> Writing minimal package.json"
cat > package.json <<'PKG'
{
  "name": "teletrade-bot-min",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node bot.mjs"
  },
  "dependencies": {
    "@aptos-labs/ts-sdk": "^1.25.0",
    "dotenv": "^16.4.5",
    "js-sha3": "^0.9.3",
    "telegraf": "^4.16.3"
  }
}
PKG

echo "==> Writing .env.example"
cat > .env.example <<'ENV'
# Telegram
BOT_TOKEN=123456:telegram-bot-token

# Aptos network: testnet | mainnet | devnet
APTOS_NETWORK=testnet

# Your published package address (the address that holds ::agent_registry / ::signal_vault)
TELETRADE_PUBLISHER=0xYOUR_PUBLISHED_PACKAGE_ADDRESS

# A testnet private key (ed25519) for sending transactions (demo only)
ADMIN_PRIVATE_KEY=0xYOUR_TESTNET_PRIVATE_KEY
ENV

echo "==> Writing README.md"
cat > README.md <<'MD'
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
MD

echo "==> Writing bot.mjs (single entry)"
cat > bot.mjs <<'BOT'
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { Aptos, AptosConfig, Account, Ed25519PrivateKey } from '@aptos-labs/ts-sdk';
import { sha3_256 } from 'js-sha3';
import crypto from 'crypto';

const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLISHER = process.env.TELETRADE_PUBLISHER; // 0x...
const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY; // 0x...
const NET = (process.env.APTOS_NETWORK || 'testnet').toUpperCase();

if (!BOT_TOKEN || !PUBLISHER || !ADMIN_PRIVATE_KEY) {
  console.error('Missing env. Set BOT_TOKEN, TELETRADE_PUBLISHER, ADMIN_PRIVATE_KEY in .env');
  process.exit(1);
}

// Aptos signer (admin) and client
const aptos = new Aptos(new AptosConfig({ network: NET }));
const adminPk = new Ed25519PrivateKey(ADMIN_PRIVATE_KEY);
const admin = Account.fromPrivateKey({ privateKey: adminPk });

// Module IDs
const MOD = {
  publisher: PUBLISHER,
  agent_registry: `${PUBLISHER}::agent_registry`,
  signal_vault: `${PUBLISHER}::signal_vault`,
};

const to0x = (h) => (h.startsWith('0x') ? h : `0x${h}`);
const sha3hex = (buf) => '0x' + sha3_256.update(buf).hex();

function aeadEncryptAESGCM(key32, plaintextBuf, aadStr = 'teletrade') {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key32, iv);
  cipher.setAAD(Buffer.from(aadStr));
  const ciphertext = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, aad: Buffer.from(aadStr), ciphertext, tag };
}

async function linkAgent(agentAddr) {
  const payload = {
    function: `${MOD.publisher}::agent_registry::link_user`,
    typeArguments: [],
    functionArguments: [agentAddr],
  };
  const tx = await aptos.transaction.build.simple({ sender: admin.accountAddress, data: payload });
  const sub = await aptos.signAndSubmitTransaction({ signer: admin, transaction: tx });
  return aptos.waitForTransaction({ transactionHash: sub.hash });
}

async function setLeverage(leverageU64) {
  const payload = {
    function: `${MOD.publisher}::agent_registry::set_user_leverage`,
    typeArguments: [],
    functionArguments: [BigInt(leverageU64)],
  };
  const tx = await aptos.transaction.build.simple({ sender: admin.accountAddress, data: payload });
  const sub = await aptos.signAndSubmitTransaction({ signer: admin, transaction: tx });
  return aptos.waitForTransaction({ transactionHash: sub.hash });
}

async function postEncryptedSignal(args) {
  const payload = {
    function: `${MOD.publisher}::signal_vault::post_signal`,
    typeArguments: [],
    functionArguments: [
      args.agent,                // address
      to0x(args.hash),           // hash_for_store
      to0x(args.hash),           // hash_for_event
      to0x(args.blob),           // ciphertext
      to0x(args.iv),             // iv
      to0x(args.aad),            // aad
      to0x(args.tag),            // tag
      BigInt(args.ts),           // seconds
    ],
  };
  const tx = await aptos.transaction.build.simple({ sender: admin.accountAddress, data: payload });
  const sub = await aptos.signAndSubmitTransaction({ signer: admin, transaction: tx });
  return aptos.waitForTransaction({ transactionHash: sub.hash });
}

// Telegram bot
const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  await ctx.reply(
    `✅ Bot alive on ${NET}\nAdmin: <code>${admin.accountAddress.toString()}</code>\nPublisher: <code>${PUBLISHER}</code>`,
    { parse_mode: 'HTML' }
  );
});

bot.command('link_agent', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const agent = parts[1];
  if (!agent) return ctx.reply('Usage: /link_agent 0x<agent_address>');
  try {
    const res = await linkAgent(agent);
    await ctx.reply(`🔗 Linked agent: <code>${agent}</code>\nversion: ${res.version}`, { parse_mode: 'HTML' });
  } catch (e) {
    await ctx.reply(`❌ link_agent failed: ${e.message}`);
  }
});

bot.command('leverage', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const lev = Number(parts[1]);
  if (!Number.isFinite(lev) || lev < 1) return ctx.reply('Usage: /leverage <u64>');
  try {
    const res = await setLeverage(lev);
    await ctx.reply(`⚙️ Leverage set to ${lev}x (version ${res.version})`);
  } catch (e) {
    await ctx.reply(`❌ set_leverage failed: ${e.message}`);
  }
});

bot.command('signal', async (ctx) => {
  // /signal BTC LONG 0.25 5
  const parts = ctx.message.text.trim().split(/\s+/);
  const [_, sym, side, qtyStr, levStr] = parts;
  if (!sym || !side || !qtyStr) return ctx.reply('Usage: /signal BTC LONG 0.25 [lev]');

  const payload = {
    symbol: sym.toUpperCase(),
    side: side.toUpperCase(),
    qty: Number(qtyStr),
    lev: Number(levStr || 1),
    ts: Date.now(),
  };
  const plain = Buffer.from(JSON.stringify(payload));

  // demo key: hash of admin privkey (replace with PIN->Argon2id later)
  const key32 = Buffer.from(sha3_256.arrayBuffer(Buffer.from(ADMIN_PRIVATE_KEY.replace(/^0x/, ''), 'hex')));
  const enc = aeadEncryptAESGCM(key32, plain, 'teletrade');

  const hashNo0x = sha3hex(plain).slice(2);

  try {
    const res = await postEncryptedSignal({
      agent: PUBLISHER,
      hash: hashNo0x,
      blob: enc.ciphertext.toString('hex'),
      iv: enc.iv.toString('hex'),
      aad: enc.aad.toString('hex'),
      tag: enc.tag.toString('hex'),
      ts: Math.floor(Date.now() / 1000),
    });
    await ctx.reply(`📡 Signal posted: <code>${hashNo0x.slice(0,16)}…</code>\nversion: ${res.version}`, { parse_mode: 'HTML' });
  } catch (e) {
    await ctx.reply(`❌ signal failed: ${e.message}`);
  }
});

bot.command('ping', (ctx) => ctx.reply('pong'));
bot.launch().then(() => console.log('Bot is running…'));
BOT

echo "==> Done. Next steps:
  1) npm i
  2) cp .env.example .env  && edit values
  3) npm start
Backups stored in: $STAMP/"
EOF

chmod +x reset-min.sh
./reset-min.sh

