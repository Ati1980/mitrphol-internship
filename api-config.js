// api-config.js
const GAS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbw2FYWp8OmAiygA4rTwAc8nphb2DyKLj0InGQoJFQKWF59ft1O16hqHNoM0iBL4IQq1/exec";

async function callGasGet(action, params = {}) {
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
  const response = await fetch(GAS_WEB_APP_URL, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: action, ...payload })
  });
  if (!response.ok) {
    throw new Error(`HTTP Error: ${response.status}`);
  }
  return await response.json();
}