const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';

const GAS_WEB_APP_URL =
  'https://script.google.com/macros/s/AKfycbw2FYWp8OmAiygA4rTwAc8nphb2DyKLj0InGQoJFQKWF59ft1O16hqHNoM0iBL4IQq1/exec';

const GET_CACHE_TTL_MS = 15 * 1000;
const LOGIN_CACHE_TTL_MS = 120 * 1000;
const WARMUP_COOLDOWN_MS = 60 * 1000;

const getCache = new Map();
const inFlightGets = new Map();
const loginCache = new Map();
let lastWarmupAt = 0;

function buildGasUrl(action, params = {}) {
  const url = new URL(GAS_WEB_APP_URL);
  url.searchParams.append('action', action);
  for (const key of Object.keys(params).sort()) {
    const val = params[key];
    if (val !== undefined && val !== null && key !== 'fresh') {
      url.searchParams.append(key, String(val));
    }
  }
  return url.toString();
}

function getCacheKey(action, params = {}) {
  const entries = Object.keys(params)
    .filter((k) => k !== 'fresh' && params[k] !== undefined && params[k] !== null)
    .sort()
    .map((k) => `${k}=${params[k]}`);
  return `${action}?${entries.join('&')}`;
}

async function fetchGasGet(action, params = {}, { forceFresh = false } = {}) {
  const cacheableActions = new Set(['getapplications', 'getuserquota', 'getallquota']);
  const isCacheable = cacheableActions.has(action);
  const key = getCacheKey(action, params);

  if (isCacheable && !forceFresh) {
    const cached = getCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }
  }

  if (inFlightGets.has(key) && !forceFresh) {
    return inFlightGets.get(key);
  }

  const targetUrl = buildGasUrl(action, params);
  const promise = (async () => {
    const response = await fetch(targetUrl, {
      method: 'GET',
      redirect: 'follow',
    });
    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status}`);
    }
    const data = await response.json();
    if (isCacheable && !(data && data.success === false)) {
      getCache.set(key, { data, expiresAt: Date.now() + GET_CACHE_TTL_MS });
    }
    return data;
  })();

  inFlightGets.set(key, promise);
  try {
    return await promise;
  } finally {
    if (inFlightGets.get(key) === promise) {
      inFlightGets.delete(key);
    }
  }
}

const APPROVED_STATUSES = new Set(['reviewed', 'approved', 'อนุมัติแล้ว']);

function isApprovedApp(item) {
  const s = String((item && (item.reviewStatus || item.status)) || '').toLowerCase().trim();
  return APPROVED_STATUSES.has(s);
}

function hasAssignedSection(item) {
  const sec = String((item && item.selectedSection) || '').trim();
  return Boolean(sec && sec !== '-');
}

async function computeNonApprovedDeductionsByAffiliation(forceFresh = false) {
  const apps = await fetchGasGet('getapplications', { username: '', role: 'admin' }, { forceFresh });
  const list = Array.isArray(apps) ? apps : [];
  const nonApprovedItems = list.filter((item) => !isApprovedApp(item) && hasAssignedSection(item));
  const countsByAff = {};
  if (!nonApprovedItems.length) return countsByAff;

  const uniqueReviewers = Array.from(
    new Set(
      nonApprovedItems
        .map((item) => String(item.reviewerUsername || '').trim())
        .filter((u) => u && u !== '-')
    )
  );

  const reviewerAffMap = {};
  await Promise.all(
    uniqueReviewers.map(async (username) => {
      try {
        const uq = await fetchGasGet('getuserquota', { username }, { forceFresh });
        if (uq && uq.affiliation) {
          reviewerAffMap[username.toLowerCase()] = String(uq.affiliation).trim();
        }
      } catch (e) {}
    })
  );

  for (const item of nonApprovedItems) {
    const revKey = String(item.reviewerUsername || '').trim().toLowerCase();
    const aff = (item.affiliation && String(item.affiliation).trim()) || reviewerAffMap[revKey] || '';
    if (aff) {
      countsByAff[aff] = (countsByAff[aff] || 0) + 1;
    }
  }
  return countsByAff;
}

async function adjustQuotaResponse(action, data, forceFresh = false) {
  if (action === 'getallquota' && data && data.success && Array.isArray(data.data)) {
    const countsByAff = await computeNonApprovedDeductionsByAffiliation(forceFresh);
    const adjustedRows = data.data.map((row) => {
      const affKey = String(row.affiliation || '').trim();
      const deduct = countsByAff[affKey] || 0;
      const approved = Number(row.approved) || 0;
      const actual = Math.max(0, (Number(row.actual) || 0) - deduct);
      return {
        ...row,
        actual,
        remaining: approved - actual,
      };
    });
    const totalApproved = adjustedRows.reduce((sum, r) => sum + (Number(r.approved) || 0), 0);
    const totalActual = adjustedRows.reduce((sum, r) => sum + (Number(r.actual) || 0), 0);
    return {
      ...data,
      data: adjustedRows,
      totals: {
        approved: totalApproved,
        actual: totalActual,
        remaining: totalApproved - totalActual,
      },
      rejectedExcluded: true,
      approvedOnlyActual: true,
    };
  }

  if (action === 'getuserquota' && data && data.affiliation) {
    const countsByAff = await computeNonApprovedDeductionsByAffiliation(forceFresh);
    const affKey = String(data.affiliation || '').trim();
    const deduct = countsByAff[affKey] || 0;
    const approved = Number(data.approved) || 0;
    const actual = Math.max(0, (Number(data.actual) || 0) - deduct);
    return {
      ...data,
      actual,
      remaining: approved - actual,
      rejectedExcluded: true,
      approvedOnlyActual: true,
    };
  }

  return data;
}

function prefetchForUser(user) {
  if (!user) return;
  const role = String(user.role || 'user').toLowerCase() === 'admin' ? 'admin' : 'user';
  const username = user.username || '';

  fetchGasGet('getapplications', {
    username: role === 'admin' ? '' : username,
    role,
  }).catch(() => {});

  if (role !== 'admin') {
    const userKey = user.username || user.email || '';
    if (userKey) {
      fetchGasGet('getuserquota', { username: userKey }).catch(() => {});
    }
  }
}

function triggerWarmup() {
  const now = Date.now();
  if (now - lastWarmupAt < WARMUP_COOLDOWN_MS) return;
  lastWarmupAt = now;
  fetchGasGet('getallquota').catch(() => {});
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password || '')).digest('hex');
}

app.use(express.json({ limit: '25mb' }));

app.use(
  '/assets',
  express.static(path.join(__dirname, 'public', 'assets'), {
    maxAge: '7d',
    etag: true,
  })
);
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));
app.use(express.static(__dirname));

app.get('/api/warmup', (req, res) => {
  triggerWarmup();
  res.json({ ok: true });
});

app.get('/api/gas', async (req, res) => {
  try {
    const { action, fresh, ...rest } = req.query;
    if (!action) {
      return res.status(400).json({ success: false, message: 'Missing action' });
    }
    const forceFresh = fresh === '1';
    const rawData = await fetchGasGet(String(action), rest, { forceFresh });
    const data = await adjustQuotaResponse(String(action), rawData, forceFresh);
    res.json(data);
  } catch (err) {
    res.status(502).json({ success: false, message: err.message || 'Upstream GAS error' });
  }
});

app.post('/api/gas', async (req, res) => {
  try {
    const body = req.body || {};
    const action = body.action;
    if (!action) {
      return res.status(400).json({ success: false, message: 'Missing action' });
    }

    if (action === 'login') {
      const uname = String(body.username || '').trim().toLowerCase();
      const pwHash = hashPassword(body.password);
      const loginKey = `${uname}:${pwHash}`;
      const cached = loginCache.get(loginKey);

      if (cached && cached.expiresAt > Date.now()) {
        prefetchForUser(cached.user);
        return res.json({ success: true, user: cached.user, cached: true });
      }

      const response = await fetch(GAS_WEB_APP_URL, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`HTTP Error: ${response.status}`);
      }
      const result = await response.json();
      if (result && result.success && result.user) {
        loginCache.set(loginKey, {
          user: result.user,
          expiresAt: Date.now() + LOGIN_CACHE_TTL_MS,
        });
        prefetchForUser(result.user);
      }
      return res.json(result);
    }

    // Mutating actions invalidate cached GET data
    getCache.clear();
    inFlightGets.clear();

    const response = await fetch(GAS_WEB_APP_URL, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status}`);
    }
    const result = await response.json();
    res.json(result);
  } catch (err) {
    res.status(502).json({ success: false, message: err.message || 'Upstream GAS error' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
  setTimeout(triggerWarmup, 500);
});
