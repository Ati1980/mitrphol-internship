// api-config.js
const GAS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbw2FYWp8OmAiygA4rTwAc8nphb2DyKLj0InGQoJFQKWF59ft1O16hqHNoM0iBL4IQq1/exec";
const LOCAL_GAS_PROXY = "/api/gas";

function warmupGas() {
  fetch('/api/warmup', { method: 'GET', keepalive: true }).catch(() => {});
}

function formatThaiPhone(val) {
  if (val === null || val === undefined) return '-';
  const s = String(val).trim();
  if (!s || s === '-') return '-';
  if (s.startsWith('0') || s.startsWith('+')) return s;
  return /^[1-9]/.test(s) ? '0' + s : s;
}

async function callGasGet(action, params = {}, options = {}) {
  const localUrl = new URL(LOCAL_GAS_PROXY, window.location.origin);
  localUrl.searchParams.append('action', action);
  for (const key in params) {
    if (params[key] !== undefined && params[key] !== null) {
      localUrl.searchParams.append(key, params[key]);
    }
  }
  if (options && options.fresh) {
    localUrl.searchParams.append('fresh', '1');
  }

  try {
    const response = await fetch(localUrl.toString(), { method: 'GET' });
    if (response.ok) {
      return await response.json();
    }
  } catch (e) {
    // Fallback to direct GAS URL below
  }

  const url = new URL(GAS_WEB_APP_URL);
  url.searchParams.append('action', action);
  for (const key in params) {
    if (params[key] !== undefined && params[key] !== null) {
      url.searchParams.append(key, params[key]);
    }
  }
  const response = await fetch(url.toString(), {
    method: 'GET',
    redirect: 'follow'
  });
  if (!response.ok) {
    throw new Error(`HTTP Error: ${response.status}`);
  }
  return await response.json();
}

async function callGasPost(action, payload = {}) {
  const bodyStr = JSON.stringify({ action: action, ...payload });
  try {
    const response = await fetch(LOCAL_GAS_PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyStr
    });
    if (response.ok) {
      return await response.json();
    }
  } catch (e) {
    // Fallback to direct GAS URL below
  }

  const response = await fetch(GAS_WEB_APP_URL, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: bodyStr
  });
  if (!response.ok) {
    throw new Error(`HTTP Error: ${response.status}`);
  }
  return await response.json();
}