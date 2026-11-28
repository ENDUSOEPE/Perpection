'use strict';

/**
 * GET /api/widget?key=<WIDGET_KEY>
 *
 * 읽기 전용 위젯 데이터 API.
 * - WIDGET_KEY 와 일치하는 key 가 있을 때만 200
 * - service_role 키는 서버 환경변수(SUPABASE_SERVICE_ROLE_KEY)에서만 읽는다. 코드/저장소에 두지 않는다.
 * - 오늘(Asia/Seoul) 위젯 렌더링에 필요한 최소 데이터만 돌려준다.
 */

const crypto = require('crypto');

const TZ = 'Asia/Seoul';
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://xpdzdxkoayhulsinysxj.supabase.co').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const WIDGET_KEY = process.env.WIDGET_KEY || '';
const USER_ID = process.env.WIDGET_USER_ID || '199ee72f-8657-4b78-9179-981cf5f968c5';

const PAGE = 1000;      // PostgREST 기본 max rows
const MAX_PAGES = 40;   // 폭주 방지용 상한

/* ---------- utils ---------- */

function kstToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  return o.year + '-' + o.month + '-' + o.day;
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a), 'utf8');
  const B = Buffer.from(String(b), 'utf8');
  if (A.length !== B.length) return false;
  try { return crypto.timingSafeEqual(A, B); } catch (e) { return false; }
}

function firstValue(v) {
  if (Array.isArray(v)) return v.length ? String(v[0]) : '';
  return v == null ? '' : String(v);
}

async function sbGet(path, range) {
  const headers = {
    apikey: SERVICE_KEY,
    Authorization: 'Bearer ' + SERVICE_KEY,
    Accept: 'application/json'
  };
  if (range) headers.Range = range;
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, { headers });
  if (!r.ok) {
    const body = await r.text().catch(function () { return ''; });
    const err = new Error('supabase ' + r.status + ' ' + path.split('?')[0] + ' ' + body.slice(0, 180));
    err.supabaseStatus = r.status;
    throw err;
  }
  return r.json();
}

// PostgREST 집계(sum)가 꺼져 있어 숫자 컬럼을 페이지 단위로 읽어 합산한다.
async function sumColumn(path) {
  let total = 0;
  let from = 0;
  for (let i = 0; i < MAX_PAGES; i++) {
    const rows = await sbGet(path, from + '-' + (from + PAGE - 1));
    if (!Array.isArray(rows) || !rows.length) break;
    for (const row of rows) {
      for (const k in row) total += Number(row[k]) || 0;
    }
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return total;
}

function fail(res, status, code, message) {
  res.status(status).json({ ok: false, error: code, message: message || '' });
}

/* ---------- handler ---------- */

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

  // 키가 서버에 없으면 어떤 요청도 통과시키지 않는다.
  if (!WIDGET_KEY) {
    return fail(res, 500, 'WIDGET_KEY_NOT_CONFIGURED', 'WIDGET_KEY environment variable is not set');
  }
  if (!SERVICE_KEY) {
    return fail(res, 500, 'SUPABASE_KEY_NOT_CONFIGURED', 'SUPABASE_SERVICE_ROLE_KEY environment variable is not set');
  }

  const given = firstValue(req && req.query ? req.query.key : '').trim();
  if (!given || !safeEqual(given, WIDGET_KEY)) {
    return fail(res, 401, 'INVALID_KEY', 'invalid widget key');
  }

  const uid = encodeURIComponent(USER_ID);
  const today = kstToday();

  try {
    const results = await Promise.all([
      // 0) 중심 목표
      sbGet('app_settings?select=core_goal&user_id=eq.' + uid + '&limit=1'),
      // 1) 영역
      sbGet('mandala_areas?select=id,name,sort_order,active&user_id=eq.' + uid + '&active=eq.true&order=sort_order.asc'),
      // 2) 과업
      sbGet('tasks?select=id,name,area_id,frequency,xp,start_time,end_time,time_slot,active&user_id=eq.' + uid + '&active=eq.true'),
      // 3) 오늘 완료 기록
      sbGet('task_records?select=id,task_id,completed_date,xp_earned&user_id=eq.' + uid + '&completed_date=eq.' + today + '&limit=' + PAGE),
      // 4) 오늘 To-do
      sbGet('daily_todos?select=id,title,status,urgency,xp,todo_date,active,due_at,duration_minutes,created_at&user_id=eq.' + uid + '&todo_date=eq.' + today + '&limit=' + PAGE),
      // 5) 고정 시간표
      sbGet('timetable_fixed?select=slot_time,task_ids&user_id=eq.' + uid),
      // 6) 오늘 시간표 배치
      sbGet('timetable_entries?select=slot_time,task_ids,todo_ids,detail_text,extra_text&user_id=eq.' + uid + '&entry_date=eq.' + today),
      // 7) 운동 루틴
      sbGet('workout_routines?select=name,max_value&user_id=eq.' + uid + '&active=eq.true&order=sort_order.asc'),
      // 8~10) 누적 XP
      sumColumn('task_records?select=xp_earned&user_id=eq.' + uid),
      sumColumn('goal_records?select=xp_earned&user_id=eq.' + uid),
      sumColumn('daily_todos?select=xp&user_id=eq.' + uid + '&status=eq.completed')
    ]);

    const settings = Array.isArray(results[0]) ? results[0][0] : results[0];
    const totalXp = (Number(results[8]) || 0) + (Number(results[9]) || 0) + (Number(results[10]) || 0);

    return res.status(200).json({
      ok: true,
      today: today,
      tz: TZ,
      generated_at: new Date().toISOString(),
      core: (settings && settings.core_goal) || '完璧超人',
      totalXp: totalXp,
      areas: results[1] || [],
      tasks: results[2] || [],
      records: results[3] || [],
      todos: results[4] || [],
      fixed: results[5] || [],
      entries: results[6] || [],
      workouts: results[7] || []
    });
  } catch (e) {
    console.error('[api/widget] failed:', (e && e.message) || e);
    return fail(res, 502, 'SUPABASE_ERROR', 'failed to read data from Supabase');
  }
};
