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

/* ========== ENV ========== */
const {
  BOT_TOKEN,
  APTOS_NETWORK = 'testnet',
  APTOS_FULLNODE_URL,
  APTOS_NODE_URL,
  APTOS_FAUCET_URL = 'https://faucet.testnet.aptoslabs.com',
  // Admin key must be stable; this drives the on-chain agent & admin record
  ADMIN_PRIVATE_KEY,
  // Your published package/module address
  MODULE_ADDR = '0xc15ccf35138f0f6ca4c498d3c17f80e3497bd9b150b0c126f02b326eb05b7255',
  // Paper engine defaults
  PAPER_START_USDC = '10000',
  DEFAULT_RISK = '5',
  // Signals
  SIGNAL_FEED_URL = 'http://34.67.134.209:5000/today',
  SIGNAL_POLL_MS = '60000',
  // Encryption seed for signal blob (optional; will derive from admin key if missing)
  SIGNAL_KEY_HEX,
} = process.env;

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN in .env');
if (!ADMIN_PRIVATE_KEY) throw new Error('Missing ADMIN_PRIVATE_KEY in .env');
if (!MODULE_ADDR) throw new Error('Missing MODULE_ADDR in .env');

/* ========== Aptos client & keys ========== */
const nodeUrl = APTOS_FULLNODE_URL || APTOS_NODE_URL;
const net = APTOS_NETWORK.toLowerCase();
const aptosConfig =
  net === 'mainnet'
    ? new AptosConfig({ network: Network.MAINNET })
    : net === 'testnet'
    ? new AptosConfig({ network: Network.TESTNET })
    : new AptosConfig({ network: Network.CUSTOM, fullnode: nodeUrl || 'https://fullnode.testnet.aptoslabs.com' });

const aptos = new Aptos(aptosConfig);

// Normalize to AIP-80 and build admin account
function normEd25519Key(str) {
  let s = (str || '').trim();
  try { s = PrivateKey.formatPrivateKey(s, 'ed25519'); } catch {}
  if (s.startsWith('ed25519-priv-')) s = s.slice('ed25519-priv-'.length);
  if (!s.startsWith('0x')) s = '0x' + s;
  return s;
}
const ADMIN_KEY_NORM = normEd25519Key(ADMIN_PRIVATE_KEY);
const adminPriv = new Ed25519PrivateKey(ADMIN_KEY_NORM);
const admin = Account.fromPrivateKey({ privateKey: adminPriv });
const ADMIN_ADDR = admin.accountAddress.toString();

/* ========== Storage ========== */
const USERS_PATH = './users.json';
const STATE_PATH = './state.json';

async function loadJson(path, fallback) {
  try { return JSON.parse(await fs.readFile(path, 'utf8')); }
  catch { return fallback; }
}
async function saveJson(path, obj) {
  await fs.writeFile(path, JSON.stringify(obj, null, 2));
}

let users = await loadJson(USERS_PATH, {});   // tid -> { addr, pk, auto, monitor, risk, paperUSDC, positions, alloc, isAdmin }
let state = await loadJson(STATE_PATH, { admin_tg_id: null, lastFeedKey: null });

/* ========== Helpers ========== */
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const to0x = (h) => (h?.startsWith('0x') ? h : `0x${h}`);
function esc(s) { return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }

function newRandomEd25519() {
  try { return Ed25519PrivateKey.generate(); }
  catch { return new Ed25519PrivateKey(crypto.randomBytes(32)); }
}

function deriveSignalKey32() {
  if (SIGNAL_KEY_HEX && /^[0-9a-fA-Fx]{64,66}$/.test(SIGNAL_KEY_HEX)) {
    return Buffer.from(SIGNAL_KEY_HEX.replace(/^0x/, ''), 'hex');
  }
  const adminRaw = Buffer.from(ADMIN_KEY_NORM.replace(/^0x/, ''), 'hex');
  return crypto.createHash('sha256').update(adminRaw).digest();
}
const SIG_KEY32 = deriveSignalKey32();

function aeadEncryptAESGCM(key32, plaintextBuf, aadStr = 'teletrade') {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key32, iv);
  cipher.setAAD(Buffer.from(aadStr));
  const ciphertext = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, aad: Buffer.from(aadStr), ciphertext, tag };
}
function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/* ========== Faucet with cooldown ========== */
const faucetRateLimit = new Map(); // tid -> last_ts
const FAUCET_COOLDOWN_MS = 45 * 60 * 1000;

async function faucetFund(address, amount = 5_000_000) { // 0.05 APT
  try {
    const res = await fetch(`${APTOS_FAUCET_URL}/mint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: address.replace(/^0x/, ''), amount }),
    });
    if (res.ok) return true;
    const alt = await fetch(`${APTOS_FAUCET_URL}/mint?address=${address}&amount=${amount}`, { method: 'POST' });
    return alt.ok;
  } catch {
    return false;
  }
}
async function ensureFaucet(tid, address, tries = 3) {
  const last = faucetRateLimit.get(tid) || 0;
  if (Date.now() - last < FAUCET_COOLDOWN_MS) return false;
  let ok = false;
  for (let i = 0; i < tries && !ok; i++) {
    ok = await faucetFund(address);
    if (!ok) await wait(1500);
  }
  if (ok) faucetRateLimit.set(tid, Date.now());
  return ok;
}

/* ========== On-chain reads ========== */
async function getAptBalance(address) {
  try {
    const res = await aptos.getAccountResource({
      accountAddress: address,
      resourceType: '0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>',
    });
    const v = BigInt(res?.data?.coin?.value ?? '0');
    return Number(v) / 1e8;
  } catch { return 0; }
}
async function hasAgentResource(addr) {
  try {
    await aptos.getAccountResource({
      accountAddress: addr,
      resourceType: `${MODULE_ADDR}::agent_registry::Agent`,
    });
    return true;
  } catch { return false; }
}
async function getUserConfig(addr) {
  try {
    const res = await aptos.getAccountResource({
      accountAddress: addr,
      resourceType: `${MODULE_ADDR}::agent_registry::UserConfig`,
    });
    const agent = `0x${res.data.agent.inner}`;
    const leverage = Number(res.data.leverage);
    const mode = Number(res.data.mode);
    return { agent, leverage, mode };
  } catch { return null; }
}

/* ========== On-chain writes (tx helpers) ========== */
async function tx(account, payload) {
  const built = await aptos.transaction.build.simple({ sender: account.accountAddress, data: payload });
  const sub = await aptos.signAndSubmitTransaction({ signer: account, transaction: built });
  await aptos.waitForTransaction({ transactionHash: sub.hash });
  return sub.hash;
}
async function registerAgentIfNeeded(maxLev = 10, metadataHex = '0x') {
  if (await hasAgentResource(ADMIN_ADDR)) return { already: true };
  const pubBytes = adminPriv.publicKey().toUint8Array();
  const payload = {
    function: `${MODULE_ADDR}::agent_registry::register_agent`,
    typeArguments: [],
    functionArguments: [
      `0x${Buffer.from(pubBytes).toString('hex')}`, // pubkey bytes
      BigInt(maxLev),
      metadataHex, // vector<u8>, ok to be 0x
    ],
  };
  const hash = await tx(admin, payload);
  return { already: false, hash };
}
async function linkUserIfNeeded(userAcc) {
  const addr = userAcc.accountAddress.toString();
  const cfg = await getUserConfig(addr);
  if (cfg && cfg.agent.toLowerCase() === ADMIN_ADDR.toLowerCase()) return { already: true };
  const payload = {
    function: `${MODULE_ADDR}::agent_registry::link_user`,
    typeArguments: [],
    functionArguments: [ADMIN_ADDR],
  };
  const hash = await tx(userAcc, payload);
  return { already: false, hash };
}
async function postSignal_user(userAcc, agentAddr, plainObj) {
  const body = Buffer.from(JSON.stringify(plainObj));
  const enc = aeadEncryptAESGCM(SIG_KEY32, body, 'teletrade');
  const h = sha256Hex(body).slice(0, 64); // 32 bytes hex
  const payload = {
    function: `${MODULE_ADDR}::signal_vault::post_signal`,
    typeArguments: [],
    functionArguments: [
      agentAddr,
      `0x${h}`,               // hash_for_store
      `0x${h}`,               // hash_for_event
      `0x${enc.ciphertext.toString('hex')}`,
      `0x${enc.iv.toString('hex')}`,
      `0x${enc.aad.toString('hex')}`,
      `0x${enc.tag.toString('hex')}`,
      BigInt(Math.floor(Date.now() / 1000)),
    ],
  };
  const hash = await tx(userAcc, payload);
  return hash;
}

/* ========== Users ========== */
function sanitizeUser(u) {
  if (!u || typeof u !== 'object') return null;
  if (typeof u.addr !== 'string' || !u.addr.startsWith('0x')) return null;
  if (typeof u.pk !== 'string') return null;
  u.auto = Boolean(u.auto);
  u.monitor = Boolean(u.monitor);
  u.isAdmin = Boolean(u.isAdmin);
  u.risk = Number.isFinite(Number(u.risk)) ? Math.max(1, Math.min(100, Number(u.risk))) : Number(DEFAULT_RISK);
  u.paperUSDC = Number.isFinite(Number(u.paperUSDC)) ? Math.max(0, Number(u.paperUSDC)) : Number(PAPER_START_USDC);
  u.positions = Array.isArray(u.positions) ? u.positions : [];
  u.alloc = Number.isFinite(Number(u.alloc)) && u.alloc > 0 && u.alloc <= 1 ? Number(u.alloc) : null;
  return u;
}
function ensureUser(tid) {
  let u = users[tid];
  // If this telegram id is the designated admin, we bind the env admin wallet
  if (state.admin_tg_id && tid === String(state.admin_tg_id)) {
    u = {
      ...(u || {}),
      addr: ADMIN_ADDR,
      pk: ADMIN_KEY_NORM,        // keep admin key attached (stable)
      isAdmin: true,
      auto: true,
      monitor: true,
      risk: Number(DEFAULT_RISK),
      paperUSDC: Number(PAPER_START_USDC),
      positions: (u && Array.isArray(u.positions)) ? u.positions : [],
      alloc: u?.alloc ?? null,
    };
    users[tid] = sanitizeUser(u);
    return users[tid];
  }

  if (!u) {
    const pk = newRandomEd25519();
    const acc = Account.fromPrivateKey({ privateKey: pk });
    u = users[tid] = {
      addr: acc.accountAddress.toString(),
      pk: pk.toString(),
      isAdmin: false,
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
    // protect: never overwrite admin wallet by accident
    if (u.isAdmin) {
      u.addr = ADMIN_ADDR;
      u.pk = ADMIN_KEY_NORM;
    }
    users[tid] = u;
  }
  return u;
}
// sanitize all
for (const k of Object.keys(users)) {
  const fixed = sanitizeUser(users[k]);
  if (fixed) users[k] = fixed;
  else delete users[k];
}
await saveJson(USERS_PATH, users);

/* ========== Paper engine ========== */
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
  for (const p of (Array.isArray(u.positions) ? u.positions : [])) {
    if (p.symbol !== symbol || p.side === newSide) { keep.push(p); continue; }
    realized += closePosition(u, p, closePrice);
  }
  u.positions = keep;
  return realized;
}
function openPaperPosition(u, sig, collateral) {
  if (!Array.isArray(u.positions)) u.positions = [];
  const c = Math.floor(Math.max(0, Math.min(collateral, u.paperUSDC)) * 100) / 100;
  if (c <= 0) return { ok: false, reason: 'Insufficient paper balance' };
  u.paperUSDC -= c;
  u.positions.push({
    symbol: String(sig.symbol).toUpperCase(),
    side: String(sig.side).toUpperCase(),
    entry: Number(sig.entry),
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

/* ========== Signal fetch & parsing ========== */
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
  items.sort((a,b)=>b._t - a._t);
  const t = items[0];
  return {
    symbol: String(t.symbol).toUpperCase(),
    side: String(t.signal || '').toUpperCase(),
    entry: Number(t.entry_price),
    stop_loss: Number(t.stop_loss ?? 0),
    take_profit: Number(t.take_profit ?? 0),
    time: t.time,
  };
}
async function fetchLatestSignal() {
  const r = await fetch(SIGNAL_FEED_URL, { timeout: 8000 });
  if (!r.ok) throw new Error(`Signal feed HTTP ${r.status}`);
  const js = await r.json();
  return { raw: js, latest: pickLatest(js) };
}
const feedKey = (s) => (s ? `${s.symbol}-${s.time}-${s.side}-${s.entry}` : null);

/* ========== UI helpers ========== */
const MAIN_KB = Markup.keyboard([
  ['/portfolio', '/riskfactor'],
  ['/size', '/stop', '/closeall'],
  ['/monitor', '/link_agent', '/deposit', '/debug'],
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

/* ========== Telegram bot ========== */
const bot = new Telegraf(BOT_TOKEN);

/* ----- /start: admin-or-user bootstrap ----- */
bot.start(async (ctx) => {
  const tid = String(ctx.from.id);
  const firstEver = !state.admin_tg_id;

  // Designate first /start as admin
  if (firstEver) {
    state.admin_tg_id = tid;
    await saveJson(STATE_PATH, state);
  }

  // Bind user record
  const u = ensureUser(tid);

  // If this is the admin, make sure agent exists (one-time) and show wallet
  if (tid === state.admin_tg_id) {
    // write back stable admin record
    users[tid] = sanitizeUser({ ...u, addr: ADMIN_ADDR, pk: ADMIN_KEY_NORM, isAdmin: true });
    await saveJson(USERS_PATH, users);

    // auto register agent if missing
    try {
      const r = await registerAgentIfNeeded(10, '0x');
      if (!r.already) console.log(`Agent registered: ${r.hash}`);
    } catch (e) {
      console.error('Auto register agent failed:', e.message);
    }
  }

  // Try funding user if needed (polite; skip if recently funded)
  await ensureFaucet(tid, u.addr).catch(()=>{});

  // Auto-link user to agent if needed
  try {
    const userAcc = Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(normEd25519Key(u.pk)) });
    await registerAgentIfNeeded().catch(()=>{});
    await linkUserIfNeeded(userAcc).catch(()=>{});
  } catch (e) {
    console.error('Auto link failed:', e.message);
  }

  // Show head + ask for position size if not set
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
    await ctx.replyWithHTML(head + `\n\nChoose position size per signal:`, { ...MAIN_KB, ...ALLOC_INLINE });
  } else {
    await ctx.replyWithHTML(
      head + `\n\nPosition size: <b>${Math.round(u.alloc * 100)}%</b> of paper balance`,
      MAIN_KB
    );
  }
});

/* ----- Toggles & settings ----- */
bot.command('stop', async (ctx) => {
  const u = ensureUser(String(ctx.from.id));
  u.auto = false; await saveJson(USERS_PATH, users);
  await ctx.reply('🔴 Auto paper trading: OFF', MAIN_KB);
});

bot.command('monitor', async (ctx) => {
  const u = ensureUser(String(ctx.from.id));
  await ctx.reply(
    `📡 Signal monitoring: <b>${u.monitor ? 'ON' : 'OFF'}</b>\nChoose monitoring status:`,
    { parse_mode: 'HTML', ...MAIN_KB, ...MONITOR_INLINE }
  );
});
bot.action(/monitor:(on|off)/, async (ctx) => {
  const tid = String(ctx.from.id);
  const u = ensureUser(tid);
  const status = ctx.match[1] === 'on';
  u.monitor = status; await saveJson(USERS_PATH, users);
  await ctx.answerCbQuery(`Monitoring ${status ? 'enabled' : 'disabled'}`);
  await ctx.editMessageText(`📡 Signal monitoring set to <b>${status ? 'ON' : 'OFF'}</b>`, { parse_mode: 'HTML', ...MAIN_KB });
});

bot.command('size', async (ctx) => {
  ensureUser(String(ctx.from.id));
  await ctx.reply('Pick how much of your paper balance to use per signal:', { ...MAIN_KB, ...ALLOC_INLINE });
});
bot.action(/alloc:(.+)/, async (ctx) => {
  const tid = String(ctx.from.id);
  const u = ensureUser(tid);
  const frac = Number(ctx.match[1]);
  if (frac > 0 && frac <= 1) {
    u.alloc = frac; await saveJson(USERS_PATH, users);
    await ctx.answerCbQuery('Position size saved');
    await ctx.editMessageText(`✅ Position size set to ${Math.round(frac * 100)}% of paper balance`, MAIN_KB);
  } else {
    await ctx.answerCbQuery('Invalid size');
  }
});

bot.command('riskfactor', async (ctx) => {
  const u = ensureUser(String(ctx.from.id));
  const parts = ctx.message.text.trim().split(/\s+/);
  const n = Number(parts[1]);
  if (Number.isFinite(n) && n >= 1 && n <= 100) {
    u.risk = Math.floor(n); await saveJson(USERS_PATH, users);
    await ctx.reply(`✅ Risk factor set to ${u.risk}x`, MAIN_KB);
  } else {
    await ctx.reply('Choose your risk (leverage):', { ...MAIN_KB, ...RISK_INLINE });
  }
});
bot.action(/rf:(\d+)/, async (ctx) => {
  const tid = String(ctx.from.id);
  const u = ensureUser(tid);
  const lev = Number(ctx.match[1] || '0');
  if (lev >= 1 && lev <= 100) {
    u.risk = lev; await saveJson(USERS_PATH, users);
    await ctx.answerCbQuery('Updated!');
    await ctx.editMessageText(`✅ Risk factor set to ${u.risk}x`, MAIN_KB);
  } else {
    await ctx.answerCbQuery('Invalid');
  }
});

/* ----- Portfolio & maintenance ----- */
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
    if (raw && positions.length) lines.push(`📊 Est. P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDC`);
    if (latest) lines.push('', `<b>Latest signal</b>`, renderSignalLine(latest));

    await ctx.replyWithHTML(lines.filter(Boolean).join('\n'), MAIN_KB);
  } catch (e) {
    await ctx.reply('❌ Portfolio error. Try again.', MAIN_KB);
  }
});

bot.command('closeall', async (ctx) => {
  try {
    const tid = String(ctx.from.id);
    const u = ensureUser(tid);
    const { raw } = await fetchLatestSignal().catch(() => ({ raw: null }));
    let realized = 0;
    if (raw) realized = closeAllPositions(u, raw);
    await saveJson(USERS_PATH, users);
    await ctx.replyWithHTML(
      `✅ Closed all positions\nRealized P&L: ${realized >= 0 ? '+' : ''}${realized.toFixed(2)} USDC\n` +
      `New paper balance: ${u.paperUSDC.toFixed(2)} USDC`,
      MAIN_KB
    );
  } catch {
    await ctx.reply('❌ Error closing positions.', MAIN_KB);
  }
});

/* ----- Link agent (manual override if needed) ----- */
bot.command('link_agent', async (ctx) => {
  try {
    const tid = String(ctx.from.id);
    const u = ensureUser(tid);
    const parts = ctx.message.text.trim().split(/\s+/);
    const agentAddr = (parts[1] && parts[1].startsWith('0x')) ? parts[1] : ADMIN_ADDR;

    const userAcc = Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(normEd25519Key(u.pk)) });
    await registerAgentIfNeeded().catch(()=>{});
    const r = await linkUserIfNeeded(userAcc);
    await ctx.replyWithHTML(
      r.already
        ? `🔗 Already linked to agent <code>${agentAddr}</code>`
        : `✅ Linked to agent <code>${agentAddr}</code>`,
      { parse_mode: 'HTML', ...MAIN_KB }
    );
  } catch (e) {
    await ctx.reply(`❌ Link agent error: ${e.message}`, MAIN_KB);
  }
});

/* ----- Deposit demo (placeholder function) ----- */
bot.command('deposit', async (ctx) => {
  await ctx.reply('Deposit function is a placeholder; wire to your Move entry if needed.', MAIN_KB);
});

/* ----- Debug ----- */
bot.command('debug', async (ctx) => {
  const tid = String(ctx.from.id);
  const u = ensureUser(tid);
  const apt = await getAptBalance(u.addr);
  await ctx.replyWithHTML(
    `<b>Debug</b>\n` +
    `TG: ${tid}\n` +
    `isAdmin: ${u.isAdmin}\n` +
    `Addr: <code>${esc(u.addr)}</code>\n` +
    `APT: ${apt.toFixed(8)}\n` +
    `Paper: ${u.paperUSDC.toFixed(2)}\n`,
    MAIN_KB
  );
});

/* ----- Error handler ----- */
bot.catch((err, ctx) => {
  console.error('Bot error:', err.message);
  ctx.reply('❌ Unexpected error.', MAIN_KB).catch(()=>{});
});

/* ========== Poller: monitor, auto-trade, on-chain post (as user) ========== */
async function handleNewSignalPack({ latest, raw }) {
  const key = feedKey(latest);
  if (key && state.lastFeedKey === key) return;
  if (key) { state.lastFeedKey = key; await saveJson(STATE_PATH, state); }

  // broadcast monitoring ping
  for (const [tid, _] of Object.entries(users)) {
    const u = ensureUser(tid);
    if (!u.monitor) continue;
    const text = latest
      ? `📡 Bot is monitoring signals...\n<b>Latest signal</b>\n${renderSignalLine(latest)}`
      : `📡 Bot is monitoring signals...\n<b>No signal</b>`;
    try { await bot.telegram.sendMessage(tid, text, { parse_mode: 'HTML', ...MAIN_KB }); } catch {}
  }

  if (!latest) return;

  // Auto-trade users
  let touched = false;
  for (const [tid,_] of Object.entries(users)) {
    const u = ensureUser(tid);
    if (!u.auto) continue;

    // Require alloc (position size)
    if (!u.alloc) {
      try {
        await bot.telegram.sendMessage(tid, 'Please select your position size before auto-trading:', { ...MAIN_KB, ...ALLOC_INLINE });
      } catch {}
      continue;
    }

    // Ensure on-chain pre-reqs for posting signals: agent exists, user linked, gas present
    try {
      await registerAgentIfNeeded().catch(()=>{});
      const userAcc = Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(normEd25519Key(u.pk)) });

      // gas: faucet if low
      const bal = await getAptBalance(u.addr);
      if (bal < 0.01) await ensureFaucet(tid, u.addr);

      await linkUserIfNeeded(userAcc).catch(()=>{});

      // Paper: close opposite then open new
      const realized = closeOppositePositions(u, latest.symbol, latest.side, latest.entry);
      const collateral = Math.floor(u.paperUSDC * u.alloc * 100) / 100;
      const r = openPaperPosition(u, latest, collateral);
      touched = true;

      // Post the signal on-chain as the user
      try {
        const hash = await postSignal_user(userAcc, ADMIN_ADDR, {
          symbol: latest.symbol,
          side: latest.side,
          entry: latest.entry,
          time: latest.time,
          auto: true,
        });
        console.log(`On-chain post (user ${tid}): ${hash}`);
      } catch (e) {
        console.error(`On-chain post failed for user ${tid}:`, e.message);
      }

      const recap =
        (realized ? `💱 Realized P&L on ${latest.symbol}: ${realized >= 0 ? '+' : ''}${realized.toFixed(2)} USDC\n` : '') +
        (r.ok
          ? `✅ PAPER ${greenRed(latest.side)} ${latest.symbol} @ ${latest.entry}\n` +
            `Collateral: ${r.used?.toFixed(2)} USDC • Leverage: ${u.risk}x\n` +
            `${blueTime(latest.time)}\n` +
            `New paper balance: ${u.paperUSDC.toFixed(2)} USDC`
          : `⚠️ Skipped trade: ${r.reason}`);

      try {
        await bot.telegram.sendMessage(tid, recap, { parse_mode: 'HTML', ...MAIN_KB });
      } catch {}
    } catch (e) {
      console.error(`Auto-trade error for ${tid}:`, e.message);
    }
  }
  if (touched) await saveJson(USERS_PATH, users);
}

async function pollLoop() {
  console.log(`[Bot] running on ${net.toUpperCase()}`);
  console.log('Admin:', ADMIN_ADDR);
  while (true) {
    try {
      const pack = await fetchLatestSignal();
      await handleNewSignalPack(pack);
      await wait(Math.max(10_000, Number(SIGNAL_POLL_MS) || 60_000));
    } catch (e) {
      console.error('Poll error:', e.message);
      await wait(20_000);
    }
  }
}

/* ========== Boot ========== */
bot.launch().then(() => {
  console.log('Bot launched ✅');
  pollLoop();
}).catch((e) => {
  console.error('Launch failed:', e.message);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

