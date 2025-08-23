// bot.mjs
import 'dotenv/config';
import fs from 'fs/promises';
import crypto from 'node:crypto';
import { Telegraf, Markup } from 'telegraf';
import {
  Aptos,
  AptosConfig,
  Network,
  Account,
  Ed25519PrivateKey,
  PrivateKey,
} from '@aptos-labs/ts-sdk';

/* ===================== ENV VALIDATION ===================== */

const {
  BOT_TOKEN,
  APTOS_NETWORK = 'testnet',
  APTOS_FULLNODE_URL,
  APTOS_NODE_URL,
  APTOS_FAUCET_URL = 'https://faucet.testnet.aptoslabs.com',
  ADMIN_PRIVATE_KEY = 'ed25519-priv-0x' + Buffer.alloc(32, 1).toString('hex'),
  PAPER_START_USDC = '10000',
  DEFAULT_RISK = '5',
  SIGNAL_FEED_URL = 'http://34.67.134.209:5000/today',
  SIGNAL_POLL_MS = '60000',
  SIGNAL_KEY_HEX,
  MODULE_ADDR,
} = process.env;

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in .env');
  process.exit(1);
}
if (!MODULE_ADDR) {
  console.warn('MODULE_ADDR not set; on-chain signal posting will be disabled');
}
if (!SIGNAL_KEY_HEX) {
  console.warn('SIGNAL_KEY_HEX not set; deriving from ADMIN_PRIVATE_KEY');
}

/* ===================== APTOS CLIENT ===================== */

const nodeUrl = APTOS_FULLNODE_URL || APTOS_NODE_URL;
const net = APTOS_NETWORK.toLowerCase(); // Moved net definition here
const aptosConfig =
  net === 'mainnet'
    ? new AptosConfig({ network: Network.MAINNET })
    : net === 'testnet'
    ? new AptosConfig({ network: Network.TESTNET })
    : new AptosConfig({ network: Network.CUSTOM, fullnode: nodeUrl || 'https://fullnode.testnet.aptoslabs.com' });

const aptos = new Aptos(aptosConfig);

// Key normalization (AIP-80)
function normEd25519Key(str) {
  let s = (str || '').trim();
  try { s = PrivateKey.formatPrivateKey(s, 'ed25519'); } catch {}
  if (s.startsWith('ed25519-priv-')) s = s.slice('ed25519-priv-'.length);
  if (!s.startsWith('0x')) s = '0x' + s;
  return s;
}

let admin;
try {
  admin = Account.fromPrivateKey({
    privateKey: new Ed25519PrivateKey(normEd25519Key(ADMIN_PRIVATE_KEY)),
  });
} catch (e) {
  console.error('Invalid ADMIN_PRIVATE_KEY:', e.message);
  process.exit(1);
}

/* ===================== STORAGE ===================== */

const USERS_PATH = './users.json';
const STATE_PATH = './state.json';

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function saveJson(path, obj) {
  try {
    await fs.writeFile(path, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error(`Failed to save ${path}:`, e.message);
  }
}

let users = await loadJson(USERS_PATH, {});
let state = await loadJson(STATE_PATH, { lastFeedKey: null });

/* ===================== HELPERS ===================== */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const to0x = (h) => (h?.startsWith('0x') ? h : `0x${h}`);

async function faucetFund(address, amount = 5_000_000) {
  try {
    const res = await fetch(`${APTOS_FAUCET_URL}/mint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: address.replace(/^0x/, ''), amount }),
    });
    if (res.ok) return true;
    const alt = await fetch(`${APTOS_FAUCET_URL}/mint?address=${address}&amount=${amount}`, { method: 'POST' });
    return alt.ok;
  } catch (e) {
    console.error(`Faucet fund failed for ${address}:`, e.message);
    return false;
  }
}

async function getAptBalance(address) {
  try {
    const res = await aptos.getAccountResource({
      accountAddress: address,
      resourceType: '0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>',
    });
    const v = BigInt(res?.data?.coin?.value ?? '0');
    return Number(v) / 1e8;
  } catch {
    return 0;
  }
}

function esc(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function newRandomEd25519() {
  try {
    return Ed25519PrivateKey.generate();
  } catch {
    return new Ed25519PrivateKey(crypto.randomBytes(32));
  }
}

/* ===================== USER SHAPE / MIGRATION ===================== */

function sanitizeUser(u) {
  if (!u || typeof u !== 'object') return null;
  if (typeof u.addr !== 'string' || !u.addr.startsWith('0x')) return null;
  if (typeof u.pk !== 'string') return null;
  u.auto = Boolean(u.auto);
  u.monitor = Boolean(u.monitor);
  u.risk = Number.isFinite(Number(u.risk)) ? Math.max(1, Math.min(100, Number(u.risk))) : Number(DEFAULT_RISK);
  u.paperUSDC = Number.isFinite(Number(u.paperUSDC)) ? Math.max(0, Number(u.paperUSDC)) : Number(PAPER_START_USDC);
  u.positions = Array.isArray(u.positions) ? u.positions : [];
  u.alloc = Number.isFinite(Number(u.alloc)) && u.alloc > 0 && u.alloc <= 1 ? Number(u.alloc) : null;
  return u;
}

function ensureUser(tid) {
  let u = users[tid];
  if (!u) {
    const pk = newRandomEd25519();
    const acc = Account.fromPrivateKey({ privateKey: pk });
    u = users[tid] = {
      addr: acc.accountAddress.toString(),
      pk: pk.toString(),
      auto: true,
      monitor: false,
      risk: Number(DEFAULT_RISK),
      paperUSDC: Number(PAPER_START_USDC),
      positions: [],
      alloc: null,
    };
  } else {
    u = sanitizeUser(u);
    if (!u) {
      delete users[tid];
      return ensureUser(tid);
    }
    users[tid] = u;
  }
  return u;
}

// Sanitize all users at startup
for (const k of Object.keys(users)) {
  const fixed = sanitizeUser(users[k]);
  if (fixed) users[k] = fixed;
  else delete users[k];
}
await saveJson(USERS_PATH, users);

/* ===================== PAPER ENGINE ===================== */

function latestPriceBySymbol(feedJson, symbol) {
  const arr = feedJson?.forecast_today_hourly?.[symbol];
  if (!Array.isArray(arr) || !arr.length) return null;
  const last = arr[arr.length - 1];
  return Number(last.entry_price) || null;
}

function closePosition(u, position, closePrice) {
  const notional = position.collateral * position.leverage;
  const change = (closePrice - position.entry) / position.entry;
  const pnl = (position.side === 'LONG' ? 1 : -1) * notional * change;
  u.paperUSDC = Math.max(0, u.paperUSDC + position.collateral + pnl);
  return pnl;
}

function closeOppositePositions(u, symbol, newSide, closePrice) {
  const keep = [];
  let realized = 0;
  for (const p of Array.isArray(u.positions) ? u.positions : []) {
    if (p.symbol !== symbol) {
      keep.push(p);
      continue;
    }
    if (p.side === newSide) {
      keep.push(p);
      continue;
    }
    realized += closePosition(u, p, closePrice);
  }
  u.positions = keep;
  return realized;
}

function closeAllPositions(u, feedJson) {
  const keep = [];
  let realized = 0;
  for (const p of Array.isArray(u.positions) ? u.positions : []) {
    const closePrice = latestPriceBySymbol(feedJson, p.symbol);
    if (!closePrice) {
      keep.push(p);
      continue;
    }
    realized += closePosition(u, p, closePrice);
  }
  u.positions = keep;
  return realized;
}

function openPaperPosition(u, { symbol, side, entry }, collateral) {
  if (!Array.isArray(u.positions)) u.positions = [];
  const c = Math.floor(Math.max(0, Math.min(collateral, u.paperUSDC)) * 100) / 100;
  if (c <= 0) return { ok: false, reason: 'Insufficient paper balance' };
  u.paperUSDC -= c;
  u.positions.push({
    symbol: String(symbol).toUpperCase(),
    side: String(side).toUpperCase(),
    entry: Number(entry),
    leverage: Number(u.risk),
    collateral: c,
    ts: Date.now(),
  });
  return { ok: true, used: c };
}

function estimatePnL(u, feedJson) {
  const positions = Array.isArray(u.positions) ? u.positions : [];
  let pnl = 0;
  for (const p of positions) {
    const nowPx = latestPriceBySymbol(feedJson, p.symbol);
    if (!nowPx || !p.entry) continue;
    const notional = p.collateral * p.leverage;
    const change = (nowPx - p.entry) / p.entry;
    pnl += (p.side === 'LONG' ? 1 : -1) * notional * change;
  }
  return pnl;
}

/* ===================== SIGNAL INGEST ===================== */

function pickLatest(feedJson) {
  const f = feedJson?.forecast_today_hourly || {};
  const items = [];
  for (const k of Object.keys(f)) {
    const arr = Array.isArray(f[k]) ? f[k] : [];
    if (!arr.length) continue;
    const last = arr[arr.length - 1];
    items.push({ symbol: k, ...last, _t: new Date(last.time).getTime() || 0 });
  }
  if (!items.length) return null;
  items.sort((a, b) => b._t - a._t);
  const top = items[0];
  return {
    symbol: String(top.symbol).toUpperCase(),
    side: String(top.signal || '').toUpperCase(),
    entry: Number(top.entry_price),
    stop_loss: Number(top.stop_loss ?? 0),
    take_profit: Number(top.take_profit ?? 0),
    time: top.time,
  };
}

async function fetchLatestSignal() {
  try {
    const r = await fetch(SIGNAL_FEED_URL, { timeout: 5000 });
    if (!r.ok) throw new Error(`Signal feed HTTP ${r.status}`);
    const js = await r.json();
    return { latest: pickLatest(js), raw: js };
  } catch (e) {
    console.error('Fetch signal failed:', e.message);
    throw e;
  }
}

const feedKey = (s) => (s ? `${s.symbol}-${s.time}-${s.side}-${s.entry}` : null);

/* ===================== On-chain Signal Posting ===================== */

function sha3_256_hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function deriveSignalKey32() {
  if (SIGNAL_KEY_HEX && /^[0-9a-fA-Fx]{64,66}$/.test(SIGNAL_KEY_HEX)) {
    return Buffer.from(SIGNAL_KEY_HEX.replace(/^0x/, ''), 'hex');
  }
  const adminRaw = Buffer.from(normEd25519Key(ADMIN_PRIVATE_KEY).replace(/^0x/, ''), 'hex');
  return crypto.createHash('sha256').update(adminRaw).digest();
}

function aeadEncryptAESGCM(key32, plaintextBuf, aadStr = 'teletrade') {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key32, iv);
  cipher.setAAD(Buffer.from(aadStr));
  const ciphertext = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, aad: Buffer.from(aadStr), ciphertext, tag };
}

async function txAdmin(data, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const tx = await aptos.transaction.build.simple({ sender: admin.accountAddress, data });
      const sub = await aptos.signAndSubmitTransaction({ signer: admin, transaction: tx });
      const result = await aptos.waitForTransaction({ transactionHash: sub.hash });
      console.log(`On-chain post successful: ${sub.hash}`);
      return { ok: true, hash: sub.hash };
    } catch (e) {
      console.error(`On-chain post attempt ${i + 1} failed:`, e.message);
      if (i === retries - 1) throw e;
      await wait(1000 * (2 ** i));
    }
  }
}

async function postSignalOnchainAuto(encPack) {
  if (!MODULE_ADDR) return { ok: false, reason: 'MODULE_ADDR not set' };

  const hex = (b) => '0x' + Buffer.from(b).toString('hex');
  const hash = sha3_256_hex(encPack.plain).slice(0, 64);

  const attempts = [
    {
      fn: `${MODULE_ADDR}::signal_vault::post_signal`,
      args: [
        to0x(admin.accountAddress.toString()),
        to0x(hash),
        to0x(hash),
        hex(encPack.ciphertext),
        hex(encPack.iv),
        hex(encPack.aad),
        hex(encPack.tag),
        BigInt(encPack.ts),
      ],
    },
    {
      fn: `${MODULE_ADDR}::signal_vault::post_encrypted_signal`,
      args: [hex(encPack.ciphertext), BigInt(encPack.ts)],
    },
    {
      fn: `${MODULE_ADDR}::signal_vault::post_encrypted_signal`,
      args: [
        to0x(admin.accountAddress.toString()),
        hex(encPack.ciphertext),
        BigInt(encPack.ts),
      ],
    },
  ];

  for (const a of attempts) {
    try {
      const payload = { function: a.fn, typeArguments: [], functionArguments: a.args };
      const res = await txAdmin(payload);
      return res;
    } catch (e) {
      console.warn(`Function ${a.fn} failed:`, e.message);
    }
  }
  return { ok: false, reason: 'All post variants failed' };
}

/* ===================== UI Helpers ===================== */

const MAIN_KB = Markup.keyboard([
  ['/portfolio', '/riskfactor'],
  ['/size', '/stop', '/closeall'],
  ['/monitor'],
]).resize();

const RISK_INLINE = Markup.inlineKeyboard([
  [Markup.button.callback('1x', 'rf:1'), Markup.button.callback('2x', 'rf:2'), Markup.button.callback('3x', 'rf:3')],
  [Markup.button.callback('5x', 'rf:5'), Markup.button.callback('10x', 'rf:10'), Markup.button.callback('20x', 'rf:20')],
]);

const ALLOC_INLINE = Markup.inlineKeyboard([
  [Markup.button.callback('25% of balance', 'alloc:0.25')],
  [Markup.button.callback('50% of balance', 'alloc:0.5')],
]);

const MONITOR_INLINE = Markup.inlineKeyboard([
  [Markup.button.callback('Enable Monitoring', 'monitor:on')],
  [Markup.button.callback('Disable Monitoring', 'monitor:off')],
]);

const greenRed = (side) => (side === 'LONG' ? '🟢 LONG' : side === 'SHORT' ? '🔴 SHORT' : side);
const blueTime = (iso) => `🔵 ${iso}`;
const renderSignalLine = (s) => (s ? `${greenRed(s.side)} ${s.symbol} @ ${s.entry}\n${blueTime(s.time)}` : '');

/* ===================== TELEGRAM ===================== */

const bot = new Telegraf(BOT_TOKEN);

// Rate limit for faucet to prevent abuse
const faucetRateLimit = new Map();
const FAUCET_COOLDOWN = 60 * 60 * 1000; // 1 hour

// /start
bot.start(async (ctx) => {
  const tid = String(ctx.from.id);
  const first = !users[tid];
  const u = ensureUser(tid);
  await saveJson(USERS_PATH, users);

  if (first && !faucetRateLimit.has(tid)) {
    faucetRateLimit.set(tid, Date.now());
    faucetFund(u.addr).catch((e) => console.error(`Faucet fund failed for ${u.addr}:`, e.message));
  }

  let sigLine = '';
  try {
    const { latest } = await fetchLatestSignal();
    if (latest) sigLine = `\n\n<b>Latest signal</b>\n${renderSignalLine(latest)}`;
  } catch {}

  const head =
    `👛 <b>Your Aptos wallet</b>\n<code>${esc(u.addr)}</code>\n\n` +
    `🟢 Auto paper trading: <b>${u.auto ? 'ON' : 'OFF'}</b>\n` +
    `📡 Signal monitoring: <b>${u.monitor ? 'ON' : 'OFF'}</b>${sigLine}`;

  if (!u.alloc) {
    await ctx.replyWithHTML(head + `\n\nChoose position size per signal:`, {
      ...MAIN_KB,
      ...ALLOC_INLINE,
    });
  } else {
    await ctx.replyWithHTML(
      head + `\n\nPosition size: <b>${Math.round(u.alloc * 100)}%</b> of paper balance`,
      MAIN_KB
    );
  }
});

// /stop
bot.command('stop', async (ctx) => {
  const u = ensureUser(String(ctx.from.id));
  u.auto = false;
  await saveJson(USERS_PATH, users);
  await ctx.reply('🔴 Auto paper trading: OFF', MAIN_KB);
});

// /monitor
bot.command('monitor', async (ctx) => {
  const u = ensureUser(String(ctx.from.id));
  await ctx.reply(
    `📡 Signal monitoring: <b>${u.monitor ? 'ON' : 'OFF'}</b>\nChoose monitoring status:`,
    { ...MAIN_KB, ...MONITOR_INLINE }
  );
});

// /monitor action
bot.action(/monitor:(on|off)/, async (ctx) => {
  try {
    const status = ctx.match[1] === 'on';
    const u = ensureUser(String(ctx.from.id));
    u.monitor = status;
    await saveJson(USERS_PATH, users);
    await ctx.answerCbQuery(`Monitoring ${status ? 'enabled' : 'disabled'}`);
    await ctx.editMessageText(
      `📡 Signal monitoring set to <b>${status ? 'ON' : 'OFF'}</b>`,
      { parse_mode: 'HTML', ...MAIN_KB }
    );
  } catch {
    await ctx.answerCbQuery('Error setting monitoring status');
  }
});

// /size
bot.command('size', async (ctx) => {
  ensureUser(String(ctx.from.id));
  await ctx.reply('Pick how much of your paper balance to use per signal:', {
    ...MAIN_KB,
    ...ALLOC_INLINE,
  });
});

// /alloc
bot.action(/alloc:(.+)/, async (ctx) => {
  try {
    const frac = Number(ctx.match[1]);
    const u = ensureUser(String(ctx.from.id));
    if (frac > 0 && frac <= 1) {
      u.alloc = frac;
      await saveJson(USERS_PATH, users);
      await ctx.answerCbQuery('Position size saved');
      await ctx.editMessageText(`✅ Position size set to ${Math.round(frac * 100)}% of paper balance`, MAIN_KB);
    } else {
      await ctx.answerCbQuery('Invalid size');
    }
  } catch {
    await ctx.answerCbQuery('Error setting size');
  }
});

// /riskfactor
bot.command('riskfactor', async (ctx) => {
  const u = ensureUser(String(ctx.from.id));
  const parts = ctx.message.text.trim().split(/\s+/);
  const n = Number(parts[1]);

  if (Number.isFinite(n) && n >= 1 && n <= 100) {
    u.risk = Math.floor(n);
    await saveJson(USERS_PATH, users);
    await ctx.reply(`✅ Risk factor set to ${u.risk}x`, MAIN_KB);
  } else {
    await ctx.reply('Choose your risk (leverage):', { ...MAIN_KB, ...RISK_INLINE });
  }
});

// /rf
bot.action(/rf:(\d+)/, async (ctx) => {
  try {
    const lev = Number(ctx.match[1] || '0');
    const u = ensureUser(String(ctx.from.id));
    if (lev >= 1 && lev <= 100) {
      u.risk = lev;
      await saveJson(USERS_PATH, users);
      await ctx.answerCbQuery('Updated!');
      await ctx.editMessageText(`✅ Risk factor set to ${u.risk}x`, MAIN_KB);
    } else {
      await ctx.answerCbQuery('Invalid');
    }
  } catch {
    await ctx.answerCbQuery('Error setting risk');
  }
});

// /portfolio
bot.command('portfolio', async (ctx) => {
  try {
    const tid = String(ctx.from.id);
    const u = ensureUser(tid);

    const [{ raw, latest }, apt] = await Promise.all([
      fetchLatestSignal().catch(() => ({ raw: null, latest: null })),
      getAptBalance(u.addr),
    ]);

    const positions = Array.isArray(u.positions) ? u.positions : [];
    const pnl = raw ? estimatePnL(u, raw) : 0;

    const lines = [
      `<b>💼 Portfolio</b>`,
      `<code>${esc(u.addr)}</code>`,
      ``,
      `APT: ${apt.toFixed(8)}  •  Paper USDC: ${u.paperUSDC.toFixed(2)}`,
      `Risk (leverage): ${u.risk}x  •  Position size: ${u.alloc ? Math.round(u.alloc * 100) + '%' : 'not set'}`,
      `Auto trading: ${u.auto ? 'ON' : 'OFF'}  •  Monitoring: ${u.monitor ? 'ON' : 'OFF'}`,
      `Open positions: ${positions.length}`,
    ];

    if (raw && positions.length) {
      lines.push(`📊 Est. P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDC`);
    }

    if (latest) {
      lines.push(
        ``,
        `<b>Latest signal</b>`,
        renderSignalLine(latest),
      );
    }

    await ctx.replyWithHTML(lines.filter(Boolean).join('\n'), MAIN_KB);
  } catch (e) {
    console.error('Portfolio error:', e.message);
    await ctx.reply('❌ Portfolio error. Try again.', MAIN_KB);
  }
});

// /closeall
bot.command('closeall', async (ctx) => {
  try {
    const tid = String(ctx.from.id);
    const u = ensureUser(tid);
    const { raw } = await fetchLatestSignal().catch(() => ({ raw: null }));
    const realized = raw ? closeAllPositions(u, raw) : 0;
    await saveJson(USERS_PATH, users);
    await ctx.replyWithHTML(
      `✅ Closed all positions\nRealized P&L: ${realized >= 0 ? '+' : ''}${realized.toFixed(2)} USDC\n` +
      `New paper balance: ${u.paperUSDC.toFixed(2)} USDC`,
      MAIN_KB
    );
  } catch (e) {
    console.error('Close all error:', e.message);
    await ctx.reply('❌ Error closing positions. Try again.', MAIN_KB);
  }
});

// /ping
bot.hears(/^\/ping$/i, (ctx) => ctx.reply('pong', MAIN_KB));

// /menu
bot.hears(/^\/menu$/i, (ctx) => ctx.reply('📋 Menu', MAIN_KB));

// Error handler
bot.catch((err, ctx) => {
  console.error('Bot error:', err.message);
  ctx.reply('❌ Unexpected error.', MAIN_KB).catch(() => {});
});

/* ===================== POLLER ===================== */

const POLL_MS = Math.max(10_000, Number(SIGNAL_POLL_MS) || 60_000);
const key32 = deriveSignalKey32();

async function handleNewSignalPack({ latest, raw }) {
  const key = feedKey(latest);
  const isNewSignal = key && state.lastFeedKey !== key;

  // Notify users with monitoring enabled
  for (const [tid, _u] of Object.entries(users)) {
    const u = ensureUser(tid);
    if (!u.monitor) continue;

    try {
      if (!latest) {
        await bot.telegram.sendMessage(
          tid,
          '📡 Bot is monitoring signals...\n<b>No signal available</b>',
          { parse_mode: 'HTML', ...MAIN_KB }
        );
      } else if (!isNewSignal) {
        await bot.telegram.sendMessage(
          tid,
          `📡 Bot is monitoring signals...\n<b>No new signal detected</b>\nLatest: ${renderSignalLine(latest)}`,
          { parse_mode: 'HTML', ...MAIN_KB }
        );
      } else {
        await bot.telegram.sendMessage(
          tid,
          `📡 Bot is monitoring signals...\n<b>New signal detected!</b>\n${renderSignalLine(latest)}`,
          { parse_mode: 'HTML', ...MAIN_KB }
        );
      }
    } catch (e) {
      console.error(`Failed to notify user ${tid} for monitoring:`, e.message);
    }
  }

  if (!isNewSignal || !latest) return;
  state.lastFeedKey = key;
  await saveJson(STATE_PATH, state);

  // Post signal on-chain
  if (MODULE_ADDR) {
    const plain = Buffer.from(JSON.stringify(latest));
    const enc = aeadEncryptAESGCM(key32, plain, 'teletrade');
    const encPack = { ...enc, plain, ts: Math.floor(Date.now() / 1000) };
    const res = await postSignalOnchainAuto(encPack);
    if (!res.ok) {
      console.error('On-chain post failed:', res.reason);
    } else {
      console.log(`Signal posted on-chain: ${res.hash}`);
    }
  }

  // Paper trades for all auto-enabled users
  let changed = false;
  for (const [tid, _u] of Object.entries(users)) {
    const u = ensureUser(tid);
    if (!u.auto) continue;

    if (!u.alloc) {
      try {
        await bot.telegram.sendMessage(
          tid,
          'Please select your position size before auto-trading:',
          { ...MAIN_KB, ...ALLOC_INLINE }
        );
      } catch {}
      continue;
    }

    // Close opposite positions
    const closePnl = closeOppositePositions(u, latest.symbol, latest.side, latest.entry);

    // Open new position
    const collateral = Math.floor(u.paperUSDC * u.alloc * 100) / 100;
    const r = openPaperPosition(u, latest, collateral);
    changed = true;

    try {
      const recap =
        (closePnl ? `💱 Realized P&L on ${latest.symbol}: ${closePnl >= 0 ? '+' : ''}${closePnl.toFixed(2)} USDC\n` : '') +
        (r.ok
          ? `✅ PAPER ${greenRed(latest.side)} ${latest.symbol} @ ${latest.entry}\n` +
            `Collateral: ${r.used?.toFixed(2)} USDC • Leverage: ${u.risk}x\n` +
            `${blueTime(latest.time)}\n` +
            `New paper balance: ${u.paperUSDC.toFixed(2)} USDC`
          : `⚠️ Skipped trade: ${r.reason}`);
      await bot.telegram.sendMessage(tid, recap, { parse_mode: 'HTML', ...MAIN_KB });
    } catch (e) {
      console.error(`Failed to notify user ${tid}:`, e.message);
    }
  }
  if (changed) await saveJson(USERS_PATH, users);
}

async function pollLoop() {
  console.log(`[Bot] running on ${net.toUpperCase()}`);
  console.log('Admin:', admin.accountAddress.toString());

  let backoff = POLL_MS;
  while (true) {
    try {
      const pack = await fetchLatestSignal();
      await handleNewSignalPack(pack);
      backoff = POLL_MS; // Reset backoff on success
    } catch (e) {
      console.error('Poll error:', e.message);
      // Notify users with monitoring enabled about failure
      for (const [tid, _u] of Object.entries(users)) {
        const u = ensureUser(tid);
        if (!u.monitor) continue;
        try {
          await bot.telegram.sendMessage(
            tid,
            '📡 Bot is monitoring signals...\n<b>Signal feed unavailable</b>',
            { parse_mode: 'HTML', ...MAIN_KB }
          );
        } catch (e) {
          console.error(`Failed to notify user ${tid} for monitoring error:`, e.message);
        }
      }
      backoff = Math.min(backoff * 2, 300_000); // Max 5 min
    }
    await wait(backoff);
  }
}

/* ===================== BOOT ===================== */

bot.launch().then(() => {
  console.log('Bot launched ✅');
  pollLoop();
}).catch((e) => {
  console.error('Launch failed:', e.message);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
