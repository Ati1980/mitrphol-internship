const crypto = require('crypto');

const GAS_WEB_APP_URL =
  'https://script.google.com/macros/s/AKfycbw2FYWp8OmAiygA4rTwAc8nphb2DyKLj0InGQoJFQKWF59ft1O16hqHNoM0iBL4IQq1/exec';

const GET_CACHE_TTL_MS = 15 * 1000;
const LOGIN_CACHE_TTL_MS = 120 * 1000;

const getCache = global.__mitrpholGetCache || (global.__mitrpholGetCache = new Map());
const inFlightGets = global.__mitrpholInFlightGets || (global.__mitrpholInFlightGets = new Map());
const loginCache = global.__mitrpholLoginCache || (global.__mitrpholLoginCache = new Map());

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

const REJECTED_STATUSES = new Set(['rejected', 'ไม่อนุมัติ']);

function isRejectedApp(item) {
  const s = String((item && (item.reviewStatus || item.status)) || '').toLowerCase().trim();
  return REJECTED_STATUSES.has(s);
}

function hasAssignedSection(item) {
  const sec = String((item && item.selectedSection) || '').trim();
  return Boolean(sec && sec !== '-');
}

async function computeRejectedDeductionsByAffiliation(forceFresh = false) {
  const apps = await fetchGasGet('getapplications', { username: '', role: 'admin' }, { forceFresh });
  const list = Array.isArray(apps) ? apps : [];
  const rejectedItems = list.filter((item) => isRejectedApp(item) && hasAssignedSection(item));
  const countsByAff = {};
  if (!rejectedItems.length) return countsByAff;

  const uniqueReviewers = Array.from(
    new Set(
      rejectedItems
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

  for (const item of rejectedItems) {
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
    const countsByAff = await computeRejectedDeductionsByAffiliation(forceFresh);
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
    };
  }

  if (action === 'getuserquota' && data && data.affiliation) {
    const countsByAff = await computeRejectedDeductionsByAffiliation(forceFresh);
    const affKey = String(data.affiliation || '').trim();
    const deduct = countsByAff[affKey] || 0;
    const approved = Number(data.approved) || 0;
    const actual = Math.max(0, (Number(data.actual) || 0) - deduct);
    return {
      ...data,
      actual,
      remaining: approved - actual,
      rejectedExcluded: true,
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

function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password || '')).digest('hex');
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { action, fresh, ...rest } = req.query || {};
      if (!action) {
        return res.status(400).json({ success: false, message: 'Missing action' });
      }
      const forceFresh = fresh === '1';
      const rawData = await fetchGasGet(String(action), rest, { forceFresh });
      const data = await adjustQuotaResponse(String(action), rawData, forceFresh);
      return res.status(200).json(data);
    }

    if (req.method === 'POST') {
      let body = req.body || {};
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
        } catch (e) {
          body = {};
        }
      }
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
          return res.status(200).json({ success: true, user: cached.user, cached: true });
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
        return res.status(200).json(result);
      }

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
      return res.status(200).json(result);
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  } catch (err) {
    return res.status(502).json({ success: false, message: err.message || 'Upstream GAS error' });
  }
};
