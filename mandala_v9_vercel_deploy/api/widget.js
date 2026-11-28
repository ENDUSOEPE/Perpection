'use strict';

/**
 * GET /api/widget?key=<WIDGET_KEY>
 *
 * 읽기 전용 위젯 데이터 API (JSON).
 * - WIDGET_KEY 와 일치하는 key 가 있을 때만 200
 * - service_role 키는 서버 환경변수(SUPABASE_SERVICE_ROLE_KEY)에서만 읽는다. 코드/저장소에 두지 않는다.
 * - 오늘(Asia/Seoul) 위젯 렌더링에 필요한 최소 데이터만 돌려준다.
 *
 * 조회 로직은 lib/widget-data.js 에 있고, 완성형 HTML(/api/widget-html)과 공유한다.
 */

const { getConfig, checkKey, fetchWidgetData } = require('../lib/widget-data');

function fail(res, status, code, message) {
  res.status(status).json({ ok: false, error: code, message: message || '' });
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const method = String((req && req.method) || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return fail(res, 405, 'METHOD_NOT_ALLOWED', 'GET only');
  }

  const cfg = getConfig();
  // 키가 서버에 없으면 어떤 요청도 통과시키지 않는다.
  if (!cfg.widgetKey) {
    return fail(res, 500, 'WIDGET_KEY_NOT_CONFIGURED', 'WIDGET_KEY environment variable is not set');
  }
  if (!cfg.serviceKey) {
    return fail(res, 500, 'SUPABASE_KEY_NOT_CONFIGURED', 'SUPABASE_SERVICE_ROLE_KEY environment variable is not set');
  }

  const verdict = checkKey(req);
  if (verdict === 'missing_config') {
    return fail(res, 500, 'WIDGET_KEY_NOT_CONFIGURED', 'widget environment variables are not set');
  }
  if (verdict === 'invalid') {
    return fail(res, 401, 'INVALID_KEY', 'invalid widget key');
  }

  try {
    const data = await fetchWidgetData();
    return res.status(200).json(data);
  } catch (e) {
    console.error('[api/widget] failed:', (e && e.message) || e);
    return fail(res, 502, 'SUPABASE_ERROR', 'failed to read data from Supabase');
  }
};
