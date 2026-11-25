const GAS_WEB_APP_URL =
  'https://script.google.com/macros/s/AKfycbw2FYWp8OmAiygA4rTwAc8nphb2DyKLj0InGQoJFQKWF59ft1O16hqHNoM0iBL4IQq1/exec';

module.exports = async function handler(req, res) {
  try {
    const now = Date.now();
    const last = global.__mitrpholLastWarmup || 0;
    if (now - last >= 60 * 1000) {
      global.__mitrpholLastWarmup = now;
      fetch(`${GAS_WEB_APP_URL}?action=getallquota`, { method: 'GET', redirect: 'follow' }).catch(() => {});
    }
  } catch (e) {}
  return res.status(200).json({ ok: true });
};
