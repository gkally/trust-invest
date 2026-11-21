/**
 * ============================================================
 *  TRUST INVEST — MASTER SERVER (JSONBin.io database edition)
 * ============================================================
 *  Single source of truth: one JSONBin bin stores the entire
 *  database (users, pending deposits, pending withdrawals,
 *  activity, metadata).
 *
 *  Run:  npm install express node-fetch@2
 *        node server.js
 *
 *  Env (optional):
 *    PORT        default 8090
 *    ADMIN_KEY   default trustadmin2024
 *
 *  Master bin id + JSONBin master key are defined below.
 * ============================================================
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const fetch = require('node-fetch');

/* ============================================================
   ⚙️  MASTER CONFIG  (JSONBin.io) — REAL CREDENTIALS
   ============================================================ */
const JSONBIN_MASTER_KEY = '$2a$10$79nUD3.O2EfLYnZO4payY.7mR000tu6KUKE09pcD8V9.vES9wePjG';
const JSONBIN_BIN_ID     = '6b01882eac6210605a999e07';
const JSONBIN_BASE       = 'https://api.jsonbin.io/v3';

const PORT      = process.env.PORT || 8090;
const ADMIN_KEY = process.env.ADMIN_KEY || 'trustadmin2024';
const WITHDRAW_CODE = '338989EBD';

/* ============================================================
   🧰  LOCAL FALLBACK CACHE
   ============================================================ */
const CACHE_FILE = path.join(__dirname, 'db_cache.json');

function defaultDb() {
  return {
    meta: {
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    users: [],              // full user objects
    pendingDeposits: [],    // { id, userId, usd, btc, txHash, status, createdAt }
    pendingWithdrawals: [], // { id, userId, usd, btc, address, status, createdAt }
    audit: []               // optional admin audit log
  };
}

let db = defaultDb();          // in-memory copy
let lastSyncAt = 0;            // timestamp of last successful pull
let writeQueue = Promise.resolve(); // serialize writes to avoid races

/* ============================================================
   📦  JSONBIN READ / WRITE
   ============================================================ */
async function jsonbinRead() {
  const res = await fetch(`${JSONBIN_BASE}/b/${JSONBIN_BIN_ID}/latest`, {
    method: 'GET',
    headers: {
      'X-Master-Key': JSONBIN_MASTER_KEY,
      'X-Bin-Meta': 'false'
    }
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`JSONBin read ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  return data && typeof data === 'object' ? data : defaultDb();
}

async function jsonbinWrite(payload) {
  const res = await fetch(`${JSONBIN_BASE}/b/${JSONBIN_BIN_ID}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Master-Key': JSONBIN_MASTER_KEY,
      'X-Bin-Versioning': 'false'
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`JSONBin write ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

/* ============================================================
   🔄  SYNC LAYER (read-on-demand, write-through)
   ============================================================ */
function normalizeDb(obj) {
  const base = defaultDb();
  if (!obj || typeof obj !== 'object') return base;
  return {
    meta: { ...base.meta, ...(obj.meta || {}) },
    users: Array.isArray(obj.users) ? obj.users : [],
    pendingDeposits: Array.isArray(obj.pendingDeposits) ? obj.pendingDeposits : [],
    pendingWithdrawals: Array.isArray(obj.pendingWithdrawals) ? obj.pendingWithdrawals : [],
    audit: Array.isArray(obj.audit) ? obj.audit : []
  };
}

async function loadDb(force = false) {
  const stale = force || Date.now() - lastSyncAt > 2000;
  if (!stale && db) return db;

  if (!db.users.length && fs.existsSync(CACHE_FILE)) {
    try {
      const cached = normalizeDb(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')));
      db = cached;
      console.log('📦 Loaded local cache on boot');
    } catch (e) {
      console.warn('Cache read failed:', e.message);
    }
  }

  try {
    const remote = normalizeDb(await jsonbinRead());
    db = remote;
    lastSyncAt = Date.now();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(db, null, 2));
    console.log('☁️  Synced from JSONBin');
  } catch (err) {
    console.error('⚠️  JSONBin read failed — using cache:', err.message);
  }
  return db;
}

async function saveDb(reason = '') {
  writeQueue = writeQueue.then(async () => {
    db.meta.updatedAt = new Date().toISOString();
    try {
      await jsonbinWrite(db);
      lastSyncAt = Date.now();
      fs.writeFileSync(CACHE_FILE, JSON.stringify(db, null, 2));
      if (reason) console.log(`💾 Saved (${reason})`);
    } catch (err) {
      console.error('⚠️  JSONBin write failed — saved to cache only:', err.message);
      fs.writeFileSync(CACHE_FILE, JSON.stringify(db, null, 2));
    }
  });
  return writeQueue;
}

/* ============================================================
   🔐  CRYPTO HELPERS
   ============================================================ */
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}
function makeSalt() { return crypto.randomBytes(16).toString('hex'); }
function makeToken() { return crypto.randomBytes(32).toString('hex'); }

/* ============================================================
   📈  DURATION / RATE HELPERS
   ------------------------------------------------------------
   Business rule: 70% return per 60 days. Any other term
   scales proportionally:

       rate   = 0.70 * (days / 60)
       profit = amount * rate
       end    = start + days (in ms)

   Allowed terms: any integer days between 1 and 1825 (5 years).
   The invest.html UI offers 15, 30, 60, 90, 120, 180, 270,
   365, 730, 1095, 1460, 1825 — but the server accepts any
   number in that range so future UIs don't need a server
   change.
   ============================================================ */
const BASE_PERIOD_DAYS = 60;
const BASE_RATE        = 0.70;
const MIN_DAYS         = 1;
const MAX_DAYS         = 1825; // 5 years

function clampDays(input) {
  const n = Math.round(Number(input));
  if (!Number.isFinite(n)) return BASE_PERIOD_DAYS;
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, n));
}
function rateForDays(days) {
  return BASE_RATE * (clampDays(days) / BASE_PERIOD_DAYS);
}

/* ============================================================
   🧪  AUTO-CREDIT MATURED INVESTMENTS
   ============================================================ */
function autoCreditMatured(user) {
  let changed = false;
  const now = Date.now();
  (user.investments || []).forEach(inv => {
    if (inv.status === 'active' && new Date(inv.endDate).getTime() <= now) {
      inv.status = 'completed';
      inv.creditedAt = new Date().toISOString();
      const payout = Number(((inv.amount || 0) + (inv.profit || 0)).toFixed(2));
      user.balance = Number(((user.balance || 0) + payout).toFixed(2));
      user.activity = user.activity || [];
      user.activity.unshift({
        type: 'maturity',
        plan: inv.plan,
        amount: payout,
        profit: inv.profit,
        days: inv.durationDays || BASE_PERIOD_DAYS,
        at: new Date().toISOString(),
        note: `Investment matured: ${inv.plan} · ${inv.durationDays || BASE_PERIOD_DAYS}d`
      });
      changed = true;
    }
  });
  return changed;
}

/* ============================================================
   🚀  EXPRESS APP
   ============================================================ */
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname)));
app.use(express.static(path.join(__dirname, 'public')));

function userFromReq(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  const userId = req.headers['x-user-id'] || token;
  return userId;
}

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || (req.body && req.body.adminKey);
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ message: 'Unauthorized: invalid admin key.' });
  }
  next();
}

/* ============================================================
   🧾  PUBLIC AUTH
   ============================================================ */
app.post('/api/register', async (req, res) => {
  try {
    await loadDb();
    const { fullName, email, phone, password } = req.body || {};
    if (!fullName || !email || !phone || !password)
      return res.status(400).json({ message: 'All fields are required.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ message: 'Invalid email address.' });
    if (password.length < 8)
      return res.status(400).json({ message: 'Password must be at least 8 characters.' });

    const normEmail = email.toLowerCase().trim();
    if (db.users.some(u => u.email === normEmail))
      return res.status(409).json({ message: 'An account with this email already exists.' });

    const salt = makeSalt();
    const user = {
      id: crypto.randomUUID(),
      fullName: fullName.trim(),
      email: normEmail,
      phone: phone.trim(),
      salt,
      passwordHash: hashPassword(password, salt),
      createdAt: new Date().toISOString(),
      balance: 0,
      active: true,
      investments: [],
      activity: []
    };
    db.users.push(user);
    await saveDb('register');

    res.status(201).json({
      message: 'Registration successful.',
      token: makeToken(),
      user: { id: user.id, fullName: user.fullName, email: user.email, phone: user.phone }
    });
  } catch (err) {
    console.error('register:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    await loadDb();
    const { identifier, email, password } = req.body || {};
    const idRaw = (identifier || email || '').toString().trim();
    if (!idRaw || !password)
      return res.status(400).json({ message: 'Email/phone and password are required.' });

    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(idRaw);
    const normPhone = idRaw.replace(/\D/g, '');
    const user = db.users.find(u =>
      isEmail ? u.email === idRaw.toLowerCase() : u.phone.replace(/\D/g, '') === normPhone
    );
    if (!user || user.active === false)
      return res.status(401).json({ message: 'Invalid credentials.' });

    if (hashPassword(password, user.salt) !== user.passwordHash)
      return res.status(401).json({ message: 'Invalid credentials.' });

    res.json({
      message: 'Login successful.',
      token: makeToken(),
      user: { id: user.id, fullName: user.fullName, email: user.email, phone: user.phone }
    });
  } catch (err) {
    console.error('login:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

/* ============================================================
   👤  USER OVERVIEW / INVEST / WITHDRAW
   ============================================================ */
app.get('/api/user/overview', async (req, res) => {
  try {
    await loadDb();
    const userId = userFromReq(req);
    const u = db.users.find(x => x.id === userId);
    if (!u) return res.status(401).json({ message: 'Unauthorized.' });

    if (autoCreditMatured(u)) await saveDb('auto-maturity');

    res.json({
      balance: u.balance || 0,
      investments: (u.investments || []).slice().sort((a, b) => new Date(b.startDate) - new Date(a.startDate)),
      withdrawals: u.withdrawals || [],
      activity: (u.activity || []).slice(0, 20)
    });
  } catch (err) {
    console.error('overview:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

app.post('/api/user/invest', async (req, res) => {
  try {
    await loadDb();
    const userId = userFromReq(req);
    const u = db.users.find(x => x.id === userId);
    if (!u) return res.status(401).json({ message: 'Unauthorized.' });

    const { plan, amount, durationDays } = req.body || {};
    const amt = Number(amount);
    if (!['bitcoin', 'ai', 'ads'].includes(plan))
      return res.status(400).json({ message: 'Invalid plan.' });
    if (!amt || amt < 10)
      return res.status(400).json({ message: 'Minimum investment is $10.' });
    if ((u.balance || 0) < amt)
      return res.status(400).json({ message: 'Insufficient balance.' });

    // ----- DURATION-AWARE RATE CALCULATION -----
    const days = clampDays(durationDays || BASE_PERIOD_DAYS);
    const rate = rateForDays(days);
    const profit = Number((amt * rate).toFixed(2));

    const start = new Date();
    const end = new Date(start.getTime() + days * 86400000);

    const investment = {
      id: crypto.randomUUID(),
      plan,
      amount: amt,
      profit,
      rate,                     // e.g. 0.70 for 60d, 0.175 for 15d
      durationDays: days,       // <-- new: stored so UI can show the term
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      status: 'active'
    };

    u.balance = Number((u.balance - amt).toFixed(2));
    u.investments = u.investments || [];
    u.investments.push(investment);
    u.activity = u.activity || [];
    u.activity.unshift({
      type: 'invest',
      plan,
      amount: amt,
      profit,
      days,
      rate,
      at: start.toISOString(),
      note: `Invested in ${plan} · ${days}d`
    });

    await saveDb('invest');

    res.status(201).json({
      message: 'Investment created.',
      balance: u.balance,
      investment
    });
  } catch (err) {
    console.error('invest:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

app.post('/api/user/withdraw', async (req, res) => {
  try {
    await loadDb();
    const userId = userFromReq(req);
    const u = db.users.find(x => x.id === userId);
    if (!u) return res.status(401).json({ message: 'Unauthorized.' });

    const { amount, btcAmount, address, code } = req.body || {};
    const amt = Number(amount);
    if (!amt || amt < 10) return res.status(400).json({ message: 'Minimum withdrawal is $10.' });
    if (!address || address.length < 20)
      return res.status(400).json({ message: 'Invalid Bitcoin address.' });
    if (!/^(bc1[a-zA-Z0-9]{20,90}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(address.trim()))
      return res.status(400).json({ message: 'Invalid Bitcoin address format.' });
    if (!code || String(code).trim().toUpperCase() !== WITHDRAW_CODE)
      return res.status(403).json({ message: 'Incorrect activation code.' });
    if ((u.balance || 0) < amt)
      return res.status(400).json({ message: 'Insufficient balance.' });

    const withdrawal = {
      id: crypto.randomUUID(),
      userId: u.id,
      usd: amt,
      btc: Number(btcAmount) || 0,
      address: address.trim(),
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    u.balance = Number((u.balance - amt).toFixed(2));
    u.withdrawals = u.withdrawals || [];
    u.withdrawals.push(withdrawal);
    u.activity = u.activity || [];
    u.activity.unshift({
      type: 'withdraw',
      amount: amt,
      btc: Number(btcAmount) || 0,
      address: address.trim(),
      at: new Date().toISOString(),
      note: 'Withdrawal request — pending admin'
    });

    db.pendingWithdrawals.push(withdrawal);
    await saveDb('withdraw');

    res.status(201).json({
      message: 'Withdrawal submitted.',
      balance: u.balance,
      withdrawal: { usd: amt, btc: Number(btcAmount) || 0, address: address.trim() }
    });
  } catch (err) {
    console.error('withdraw:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

/* ---------- public pending deposit logging (deposit.html) ---------- */
app.post('/api/deposits/pending', async (req, res) => {
  try {
    await loadDb();
    const { userId, usd, btc, txHash } = req.body || {};
    if (!userId || !txHash) return res.status(400).json({ message: 'Missing fields.' });
    const u = db.users.find(x => x.id === userId);
    if (!u) return res.status(404).json({ message: 'User not found.' });

    const record = {
      id: crypto.randomUUID(),
      userId,
      usd: Number(usd) || 0,
      btc: Number(btc) || 0,
      txHash,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    db.pendingDeposits.push(record);
    await saveDb('pending-deposit');
    res.status(201).json({ message: 'Deposit submitted.', id: record.id });
  } catch (err) {
    console.error('pending-deposit:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

/* ============================================================
   🛡️  ADMIN ENDPOINTS
   ============================================================ */
app.post('/api/admin/verify', (req, res) => {
  const { key } = req.body || {};
  if (key === ADMIN_KEY) return res.json({ ok: true });
  res.status(401).json({ message: 'Invalid admin key.' });
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    await loadDb();
    const users = db.users.map(u => ({
      id: u.id,
      fullName: u.fullName,
      email: u.email,
      phone: u.phone,
      balance: u.balance || 0,
      active: u.active !== false,
      createdAt: u.createdAt,
      investmentsCount: (u.investments || []).length
    }));
    res.json({ users });
  } catch (err) {
    console.error('admin users:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

app.post('/api/admin/users/:id/credit', requireAdmin, async (req, res) => {
  try {
    await loadDb();
    const { amount, note } = req.body || {};
    const amt = Number(amount);
    if (!amt || amt <= 0) return res.status(400).json({ message: 'Invalid amount.' });

    const u = db.users.find(x => x.id === req.params.id);
    if (!u) return res.status(404).json({ message: 'User not found.' });

    u.balance = Number(((u.balance || 0) + amt).toFixed(2));
    u.activity = u.activity || [];
    u.activity.unshift({ type: 'credit', amount: amt, note: note || '', at: new Date().toISOString() });
    await saveDb('admin-credit');
    res.json({ message: 'Credited.', balance: u.balance });
  } catch (err) {
    console.error('credit:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

app.post('/api/admin/users/:id/debit', requireAdmin, async (req, res) => {
  try {
    await loadDb();
    const { amount, note } = req.body || {};
    const amt = Number(amount);
    if (!amt || amt <= 0) return res.status(400).json({ message: 'Invalid amount.' });

    const u = db.users.find(x => x.id === req.params.id);
    if (!u) return res.status(404).json({ message: 'User not found.' });
    if ((u.balance || 0) < amt) return res.status(400).json({ message: 'Insufficient balance.' });

    u.balance = Number(((u.balance || 0) - amt).toFixed(2));
    u.activity = u.activity || [];
    u.activity.unshift({ type: 'debit', amount: amt, note: note || '', at: new Date().toISOString() });
    await saveDb('admin-debit');
    res.json({ message: 'Debited.', balance: u.balance });
  } catch (err) {
    console.error('debit:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

app.post('/api/admin/users/:id/toggle', requireAdmin, async (req, res) => {
  try {
    await loadDb();
    const u = db.users.find(x => x.id === req.params.id);
    if (!u) return res.status(404).json({ message: 'User not found.' });
    u.active = u.active === false ? true : false;
    await saveDb('admin-toggle');
    res.json({ message: u.active ? 'Activated.' : 'Deactivated.', active: u.active });
  } catch (err) {
    console.error('toggle:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

app.post('/api/admin/users/:id/password', requireAdmin, async (req, res) => {
  try {
    await loadDb();
    const { password } = req.body || {};
    if (!password || password.length < 8)
      return res.status(400).json({ message: 'Password must be at least 8 characters.' });
    const u = db.users.find(x => x.id === req.params.id);
    if (!u) return res.status(404).json({ message: 'User not found.' });
    u.salt = makeSalt();
    u.passwordHash = hashPassword(password, u.salt);
    await saveDb('admin-password');
    res.json({ message: 'Password updated.' });
  } catch (err) {
    console.error('password:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    await loadDb();
    const idx = db.users.findIndex(x => x.id === req.params.id);
    if (idx === -1) return res.status(404).json({ message: 'User not found.' });
    const [removed] = db.users.splice(idx, 1);
    db.pendingDeposits = db.pendingDeposits.filter(d => d.userId !== removed.id);
    db.pendingWithdrawals = db.pendingWithdrawals.filter(w => w.userId !== removed.id);
    await saveDb('admin-delete');
    res.json({ message: 'User removed.' });
  } catch (err) {
    console.error('delete user:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

/* ---------- pending deposits ---------- */
app.get('/api/admin/pending-deposits', requireAdmin, async (req, res) => {
  try {
    await loadDb();
    const deposits = db.pendingDeposits.filter(d => d.status === 'pending').map(d => {
      const u = db.users.find(x => x.id === d.userId) || {};
      return {
        id: d.id,
        userId: d.userId,
        usd: d.usd,
        btc: d.btc,
        txHash: d.txHash,
        createdAt: d.createdAt,
        user: { fullName: u.fullName, email: u.email, phone: u.phone }
      };
    });
    res.json({ deposits });
  } catch (err) {
    console.error('pending-deposits:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

app.post('/api/admin/pending-deposits/:id/confirm', requireAdmin, async (req, res) => {
  try {
    await loadDb();
    const d = db.pendingDeposits.find(x => x.id === req.params.id);
    if (!d) return res.status(404).json({ message: 'Deposit not found.' });
    if (d.status !== 'pending') return res.status(400).json({ message: 'Already processed.' });

    const u = db.users.find(x => x.id === d.userId);
    if (!u) return res.status(404).json({ message: 'User not found.' });

    u.balance = Number(((u.balance || 0) + Number(d.usd)).toFixed(2));
    u.activity = u.activity || [];
    u.activity.unshift({
      type: 'deposit',
      amount: Number(d.usd),
      btc: d.btc,
      txHash: d.txHash,
      note: 'Admin-confirmed deposit',
      at: new Date().toISOString()
    });

    d.status = 'confirmed';
    d.confirmedAt = new Date().toISOString();
    await saveDb('admin-confirm-deposit');
    res.json({ message: 'Deposit confirmed.' });
  } catch (err) {
    console.error('confirm deposit:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

app.post('/api/admin/pending-deposits/:id/decline', requireAdmin, async (req, res) => {
  try {
    await loadDb();
    const d = db.pendingDeposits.find(x => x.id === req.params.id);
    if (!d) return res.status(404).json({ message: 'Deposit not found.' });
    if (d.status !== 'pending') return res.status(400).json({ message: 'Already processed.' });
    d.status = 'declined';
    d.declinedAt = new Date().toISOString();
    await saveDb('admin-decline-deposit');
    res.json({ message: 'Deposit declined.' });
  } catch (err) {
    console.error('decline deposit:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

/* ---------- pending withdrawals ---------- */
app.get('/api/admin/pending-withdrawals', requireAdmin, async (req, res) => {
  try {
    await loadDb();
    const list = db.pendingWithdrawals.filter(w => w.status === 'pending').map(w => {
      const u = db.users.find(x => x.id === w.userId) || {};
      return {
        id: w.id,
        userId: w.userId,
        usd: w.usd,
        btc: w.btc,
        address: w.address,
        createdAt: w.createdAt,
        user: { fullName: u.fullName, email: u.email, phone: u.phone }
      };
    });
    res.json({ withdrawals: list });
  } catch (err) {
    console.error('pending-withdrawals:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

app.post('/api/admin/pending-withdrawals/:id/confirm', requireAdmin, async (req, res) => {
  try {
    await loadDb();
    const w = db.pendingWithdrawals.find(x => x.id === req.params.id);
    if (!w) return res.status(404).json({ message: 'Withdrawal not found.' });
    if (w.status !== 'pending') return res.status(400).json({ message: 'Already processed.' });
    w.status = 'paid';
    w.paidAt = new Date().toISOString();
    await saveDb('admin-withdraw-paid');
    res.json({ message: 'Withdrawal marked as paid.' });
  } catch (err) {
    console.error('withdraw confirm:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

app.post('/api/admin/pending-withdrawals/:id/decline', requireAdmin, async (req, res) => {
  try {
    await loadDb();
    const w = db.pendingWithdrawals.find(x => x.id === req.params.id);
    if (!w) return res.status(404).json({ message: 'Withdrawal not found.' });
    if (w.status !== 'pending') return res.status(400).json({ message: 'Already processed.' });

    const u = db.users.find(x => x.id === w.userId);
    if (u) {
      u.balance = Number(((u.balance || 0) + Number(w.usd)).toFixed(2));
      u.activity = u.activity || [];
      u.activity.unshift({
        type: 'withdraw-refund',
        amount: Number(w.usd),
        at: new Date().toISOString(),
        note: 'Withdrawal declined — refunded'
      });
    }
    w.status = 'declined';
    w.declinedAt = new Date().toISOString();
    await saveDb('admin-withdraw-declined');
    res.json({ message: 'Withdrawal declined and refunded.' });
  } catch (err) {
    console.error('withdraw decline:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

/* ============================================================
   🩺  HEALTH / DEBUG
   ============================================================ */
app.get('/api/health', async (req, res) => {
  let remoteOk = false;
  try { await loadDb(true); remoteOk = true; } catch (e) {}
  res.json({
    ok: true,
    jsonbinBinId: JSONBIN_BIN_ID,
    remoteReachable: remoteOk,
    lastSyncAt: lastSyncAt ? new Date(lastSyncAt).toISOString() : null,
    users: db.users.length,
    pendingDeposits: db.pendingDeposits.length,
    pendingWithdrawals: db.pendingWithdrawals.length
  });
});

/* ============================================================
   🧭  FALLBACK
   ============================================================ */
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api/')) return next();

  // Clean URL: /about -> public/about.html
  const clean = req.path.replace(/^\/+|\/+$/g, '');
  if (clean) {
    const candidate = path.join(__dirname, 'public', clean + '.html');
    if (fs.existsSync(candidate)) return res.sendFile(candidate);
  }

  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ============================================================
   ▶️  START
   ============================================================ */
(async () => {
  await loadDb(true);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`
============================================================
 🚀  Trust Invest running on http://localhost:${PORT}
============================================================
 📦  JSONBin bin:  ${JSONBIN_BIN_ID}
 👥  Users:        ${db.users.length}
 💰  Pending dep:  ${db.pendingDeposits.length}
 💸  Pending wd:   ${db.pendingWithdrawals.length}
 🛡️  Admin key:    ${ADMIN_KEY}
============================================================
    `);
  });
})();
