'use strict';

/**
 * 위젯 데이터 조회 공용 모듈.
 *
 * - /api/widget      : JSON (읽기 전용 API)
 * - /api/widget-html : 서버에서 완성한 HTML (SSR)
 *
 * 두 엔드포인트가 같은 조회 로직을 쓰도록 여기에 모은다.
 * service_role 키는 서버 환경변수(SUPABASE_SERVICE_ROLE_KEY)에서만 읽고 코드에 두지 않는다.
 */

const crypto = require('crypto');

const TZ = 'Asia/Seoul';
const DEFAULT_SUPABASE_URL = 'https://xpdzdxkoayhulsinysxj.supabase.co';
const DEFAULT_USER_ID = '199ee72f-8657-4b78-9179-981cf5f968c5';

const PAGE = 1000;      // PostgREST 기본 max rows
const MAX_PAGES = 40;   // 폭주 방지용 상한

function getConfig() {
  return {
    supabaseUrl: (process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/, ''),
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    widgetKey: process.env.WIDGET_KEY || '',
    userId: process.env.WIDGET_USER_ID || DEFAULT_USER_ID
  };
}

/* ---------- utils ---------- */

function kstParts(d) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(d || new Date());
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  const y = +o.year, m = +o.month, day = +o.day, hh = +o.hour, mm = +o.minute;
  return {
    y: y, m: m, d: day, hh: hh, mm: mm, min: hh * 60 + mm,
    date: y + '-' + pad2(m) + '-' + pad2(day),
    dow: new Date(Date.UTC(y, m - 1, day)).getUTCDay()
  };
}

function kstToday() {
  return kstParts(new Date()).date;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Asia/Seoul 기준 '이번 주' 월~일 범위.
 * index.html 의 startOfWeek()(월요일 시작)과 같은 기준을 쓴다.
 */
function weekRange(parts) {
  const p = parts || kstParts(new Date());
  const offset = (p.dow + 6) % 7; // 월=0 … 일=6
  const monday = new Date(Date.UTC(p.y, p.m - 1, p.d - offset));
  const sunday = new Date(monday.getTime() + 6 * 86400000);
  return {
    start: monday.toISOString().slice(0, 10),
    end: sunday.toISOString().slice(0, 10)
  };
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

/**
 * 요청 키 검증.
 * 반환: 'ok' | 'missing_config' | 'invalid'
 */
function checkKey(req) {
  const cfg = getConfig();
  if (!cfg.widgetKey || !cfg.serviceKey) return 'missing_config';
  const given = firstValue(req && req.query ? req.query.key : '').trim();
  if (!given || !safeEqual(given, cfg.widgetKey)) return 'invalid';
  return 'ok';
}

async function sbGet(cfg, path) {
  const headers = {
    apikey: cfg.serviceKey,
    Authorization: 'Bearer ' + cfg.serviceKey,
    Accept: 'application/json'
  };
  const r = await fetch(cfg.supabaseUrl + '/rest/v1/' + path, { headers });
  if (!r.ok) {
    const body = await r.text().catch(function () { return ''; });
    const err = new Error('supabase ' + r.status + ' ' + path.split('?')[0] + ' ' + body.slice(0, 180));
    err.supabaseStatus = r.status;
    throw err;
  }
  return r.json();
}

/**
 * Supabase REST 쓰기(POST/PATCH/DELETE). 응답 본문이 있으면 파싱해 돌려준다.
 */
async function sbSend(cfg, path, method, body, prefer) {
  const headers = {
    apikey: cfg.serviceKey,
    Authorization: 'Bearer ' + cfg.serviceKey,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(cfg.supabaseUrl + '/rest/v1/' + path, {
    method: method,
    headers: headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text().catch(function () { return ''; });
  if (!r.ok) {
    const err = new Error('supabase ' + r.status + ' ' + method + ' ' + path.split('?')[0] + ' ' + String(text).slice(0, 200));
    err.supabaseStatus = r.status;
    throw err;
  }
  if (!text) return [];
  try { return JSON.parse(text); } catch (e) { return []; }
}

// PostgREST 집계(sum)가 꺼져 있어 숫자 컬럼을 1000행씩 읽어 합산한다.
async function sumColumn(cfg, path) {
  let total = 0;
  let offset = 0;
  for (let i = 0; i < MAX_PAGES; i++) {
    const rows = await sbGet(cfg, path + '&limit=' + PAGE + '&offset=' + offset);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const row of rows) {
      for (const k in row) total += Number(row[k]) || 0;
    }
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  return total;
}

/**
 * 오늘(Asia/Seoul) 위젯에 필요한 데이터를 모아 돌려준다.
 * 실패하면 예외를 던진다 (호출부가 상태코드로 변환).
 */
async function fetchWidgetData() {
  const cfg = getConfig();
  const uid = encodeURIComponent(cfg.userId);
  const today = kstToday();
  const week = weekRange();
  // 이번 주(월~일) 일정. 월요일 이전에 시작해 이번 주로 이어지는 일정도 포함한다.
  const weekFilter = '&or=(and(event_date.gte.' + week.start + ',event_date.lte.' + week.end + '),' +
    'and(event_date.lt.' + week.start + ',end_date.gte.' + week.start + '))';

  const results = await Promise.all([
    // 0) 중심 목표
    sbGet(cfg, 'app_settings?select=core_goal&user_id=eq.' + uid + '&limit=1'),
    // 1) 영역
    sbGet(cfg, 'mandala_areas?select=id,name,sort_order,active&user_id=eq.' + uid + '&active=eq.true&order=sort_order.asc'),
    // 2) 과업
    sbGet(cfg, 'tasks?select=id,name,area_id,frequency,xp,start_time,end_time,time_slot,active&user_id=eq.' + uid + '&active=eq.true'),
    // 3) 오늘 완료 기록
    sbGet(cfg, 'task_records?select=id,task_id,completed_date,xp_earned&user_id=eq.' + uid + '&completed_date=eq.' + today + '&limit=' + PAGE),
    // 4) 오늘 To-do
    sbGet(cfg, 'daily_todos?select=id,title,status,urgency,xp,todo_date,active,due_at,duration_minutes,created_at&user_id=eq.' + uid + '&todo_date=eq.' + today + '&limit=' + PAGE),
    // 5) 고정 시간표
    sbGet(cfg, 'timetable_fixed?select=slot_time,task_ids&user_id=eq.' + uid),
    // 6) 오늘 시간표 배치
    sbGet(cfg, 'timetable_entries?select=slot_time,task_ids,todo_ids,detail_text,extra_text&user_id=eq.' + uid + '&entry_date=eq.' + today),
    // 7) 운동 루틴
    sbGet(cfg, 'workout_routines?select=name,max_value&user_id=eq.' + uid + '&active=eq.true&order=sort_order.asc'),
    // 8) 이번 주 일정
    sbGet(cfg, 'calendar_events?select=id,event_date,end_date,title,start_time,event_type&user_id=eq.' + uid +
      weekFilter + '&order=event_date.asc,start_time.asc&limit=' + PAGE),
    // 9~11) 누적 XP
    sumColumn(cfg, 'task_records?select=xp_earned&user_id=eq.' + uid),
    sumColumn(cfg, 'goal_records?select=xp_earned&user_id=eq.' + uid),
    sumColumn(cfg, 'daily_todos?select=xp&user_id=eq.' + uid + '&status=eq.completed')
  ]);

  const settings = Array.isArray(results[0]) ? results[0][0] : results[0];
  const totalXp = (Number(results[9]) || 0) + (Number(results[10]) || 0) + (Number(results[11]) || 0);

  return {
    ok: true,
    today: today,
    tz: TZ,
    week: week,
    generated_at: new Date().toISOString(),
    core: (settings && settings.core_goal) || '完璧超人',
    totalXp: totalXp,
    areas: results[1] || [],
    tasks: results[2] || [],
    records: results[3] || [],
    todos: results[4] || [],
    fixed: results[5] || [],
    entries: results[6] || [],
    workouts: results[7] || [],
    events: results[8] || []
  };
}

module.exports = {
  TZ: TZ,
  getConfig: getConfig,
  checkKey: checkKey,
  fetchWidgetData: fetchWidgetData,
  kstParts: kstParts,
  kstToday: kstToday,
  weekRange: weekRange,
  sbSend: sbSend,
  pad2: pad2,
  firstValue: firstValue,
  safeEqual: safeEqual
};
