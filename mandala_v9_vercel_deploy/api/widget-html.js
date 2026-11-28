'use strict';

/**
 * GET /widget?key=<WIDGET_KEY>  →  vercel.json rewrite  →  /api/widget-html
 *
 * 서버 완성형(SSR) 위젯 — 세로 4단.
 *   ① 지금 할 일   ② 오늘 To-do   ③ 이번 주 캘린더   ④ 만다라트(3×3)
 *
 * 서버가 Supabase 에서 오늘(Asia/Seoul) 데이터를 읽어 완성된 HTML 을 한 번에 돌려준다.
 * JS 가 실행되지 않아도 네 섹션이 모두 채워져 있고, JS 가 실행되면:
 *   - 위젯 높이에 맞춰 위아래 공백 없이 네 섹션이 화면을 꽉 채운다(fit).
 *   - 과업/To-do 를 탭하면 POST /api/widget/toggle 로 완료 체크/해제(낙관적 UI + 실패 시 롤백).
 *   - 만다라트 영역 칸을 탭하면 그 영역 8개 과업 시트가 열려 거기서도 체크할 수 있다.
 */

const { getConfig, checkKey, fetchWidgetData, kstParts, pad2 } = require('../lib/widget-data');

const TZ = 'Asia/Seoul';
const AREA_COLORS = ['#8fa4ff', '#b58cff', '#4fd8a4', '#ffc75f', '#59c8f5', '#ff9e80', '#b9e05f', '#7ee0d5'];
const URGENCY_ORDER = { TOP: -100, A: 0, B: 1, C: 2 };
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const DAY_FIRST = 4 * 60;       // 04:00
const DAY_LAST = 21 * 60 + 30;  // 21:30 (slot ends 22:00)
const SET_RATIOS = [0.45, 0.45, 0.40, 0.35, 0.35];
const NOW_MAX = 3;
const TODO_MAX = 8;
const URGENCY_CLASS = { TOP: 'top', A: 'a', B: 'b', C: 'c' };

/* ---------- utils ---------- */

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function fmtNum(n) {
  const v = Math.round(Number(n) || 0);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function slice5(v) {
  return v == null ? '' : String(v).slice(0, 5);
}

function hhmm(v) {
  if (!v) return null;
  const m = String(v).slice(0, 5).split(':');
  const h = Number(m[0]), mm = Number(m[1]);
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
  return h * 60 + mm;
}

function slotLabel(min) {
  return pad2(Math.floor(min / 60)) + ':' + pad2(min % 60);
}

function normName(v) {
  return String(v == null ? '' : v).toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
    .replace(/[\s·・,.\-_/+]/g, '');
}

function calcSets(maxValue) {
  const n = Number(maxValue);
  if (!Number.isFinite(n) || n < 0) return [];
  return SET_RATIOS.map(function (r) { return Math.round(n * r); });
}

function dateParts(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  return { y: y, m: mo, d: d, dow: new Date(Date.UTC(y, mo - 1, d)).getUTCDay() };
}

/* ---------- context ---------- */

function buildCtx(data) {
  const parts = kstParts(new Date());
  const today = data.today || parts.date;
  const areas = Array.isArray(data.areas) ? data.areas : [];
  const areaById = new Map();
  for (const a of areas) areaById.set(String(a.id), a);
  const records = Array.isArray(data.records) ? data.records : [];
  const doneSet = new Set();
  for (const r of records) if (r.completed_date === today) doneSet.add(String(r.task_id));
  return {
    core: data.core || '完璧超人',
    totalXp: Number(data.totalXp) || 0,
    areas: areas,
    areaById: areaById,
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    todos: Array.isArray(data.todos) ? data.todos : [],
    fixed: Array.isArray(data.fixed) ? data.fixed : [],
    entries: Array.isArray(data.entries) ? data.entries : [],
    workouts: Array.isArray(data.workouts) ? data.workouts : [],
    events: Array.isArray(data.events) ? data.events : [],
    week: data.week || { start: today, end: today },
    today: today,
    parts: parts,
    doneSet: doneSet,
    now: parts.min
  };
}

function dailyTasks(c) {
  return c.tasks.filter(function (t) { return t.frequency === 'daily'; });
}

function isDone(c, id) {
  return c.doneSet.has(String(id));
}

function areaColor(c, area) {
  const i = area ? c.areas.indexOf(area) : -1;
  return AREA_COLORS[(i < 0 ? 0 : i) % AREA_COLORS.length];
}

function workoutsForTask(c, task) {
  const n = normName(task && task.name);
  if (n.length < 2) return [];
  const out = [];
  for (const w of c.workouts) {
    const m = normName(w.name);
    if (m.length < 2) continue;
    if (m === n || m.includes(n) || n.includes(m)) out.push(w);
    if (out.length >= 2) break;
  }
  return out;
}

/* ---------- rows ---------- */

function beginRow(cls, dataAttrs, done) {
  return '<li class="row' + (cls ? ' ' + cls : '') + (done ? ' done' : '') + '" ' + dataAttrs +
    ' role="button" tabindex="0" aria-pressed="' + (done ? 'true' : 'false') + '">' +
    '<span class="box" aria-hidden="true"></span><span class="main">';
}

function taskRow(c, t) {
  const aid = t.area_id != null ? String(t.area_id) : '';
  const a = aid ? c.areaById.get(aid) : null;
  const done = isDone(c, t.id);
  const subs = [];
  for (const w of workoutsForTask(c, t)) {
    const sets = calcSets(w.max_value);
    if (!sets.length) continue;
    const total = sets.reduce(function (x, y) { return x + y; }, 0);
    const nm = String(w.name).replace(/^\([^)]*\)\s*/, '');
    subs.push(esc(nm) + ' ' + sets.join('·') + ' (총 ' + total + ')');
  }
  const attrs = 'data-k="task" data-id="' + esc(t.id) + '" data-xp="' + (Math.round(Number(t.xp) || 0)) + '"' +
    (aid ? ' data-area="' + esc(aid) + '"' : '');
  return beginRow('', attrs, done) +
    '<span class="title">' +
    (a ? '<span class="han" style="--c:' + areaColor(c, a) + '">' + esc(a.name) + '</span>' : '') +
    esc(t.name) + '</span>' +
    (subs.length ? '<span class="sub">' + subs.join('  /  ') + '</span>' : '') +
    '</span></li>';
}

function dueLabel(c, t) {
  if (!t.due_at) return '';
  const d = new Date(t.due_at);
  if (Number.isNaN(d.getTime())) return '';
  const p = kstParts(d);
  const time = slotLabel(p.min);
  if (p.date === c.today) return '오늘 ' + time;
  const now = c.parts;
  const base = new Date(Date.UTC(now.y, now.m - 1, now.d));
  const target = new Date(Date.UTC(p.y, p.m - 1, p.d));
  const dd = Math.round((target - base) / 86400000);
  const stamp = pad2(p.m) + '/' + pad2(p.d) + ' ' + time;
  if (dd === 1) return '내일 ' + time;
  if (dd === -1) return '어제 ' + stamp;
  if (dd > 1) return 'D-' + dd + ' · ' + stamp;
  return stamp;
}

function todoRow(c, t) {
  const st = t.status || 'pending';
  const done = st === 'completed';
  const u = URGENCY_CLASS[t.urgency || ''] || '';
  const due = dueLabel(c, t);
  const attrs = 'data-k="todo" data-id="' + esc(t.id) + '" data-xp="' + (Math.round(Number(t.xp) || 0)) + '"' +
    ' data-prev="' + esc(done ? 'in_progress' : st) + '"';
  return beginRow(u ? 'u-' + u : '', attrs, done) +
    '<span class="title">' + esc(t.title) + '</span>' +
    (due ? '<span class="sub">' + esc(due) + '</span>' : '') +
    '</span></li>';
}

/* ---------- slot composition ---------- */

function todoCoversSlot(c, t, slotMin) {
  if (!t || !t.due_at) return false;
  const d = new Date(t.due_at);
  if (Number.isNaN(d.getTime())) return false;
  const p = kstParts(d);
  if (p.date !== c.today) return false;
  const dur = Number(t.duration_minutes) > 0 ? Number(t.duration_minutes) : 30;
  return slotMin >= p.min && slotMin < p.min + dur;
}

function slotItems(c, slotMin) {
  const slot = slotLabel(slotMin);
  const entry = c.entries.find(function (e) { return slice5(e.slot_time) === slot; }) || null;
  const fixed = c.fixed.find(function (f) { return slice5(f.slot_time) === slot; }) || null;
  const snapIds = entry && Array.isArray(entry.task_ids) ? entry.task_ids : [];
  const baseIds = (snapIds.length ? snapIds : (fixed && Array.isArray(fixed.task_ids) ? fixed.task_ids : [])).map(String);

  const seenT = new Set();
  const tasks = [];
  for (const id of baseIds) {
    if (seenT.has(id)) continue;
    seenT.add(id);
    const t = c.tasks.find(function (x) { return String(x.id) === id; });
    if (t) tasks.push(t);
  }

  const todoIds = new Set(((entry && entry.todo_ids) || []).map(String));
  const seenD = new Set();
  const todos = c.todos.filter(function (t) {
    if (t.active === false) return false;
    if (t.todo_date !== c.today) return false;
    if (['cancelled', 'postponed'].includes(t.status || 'pending')) return false;
    const byId = todoIds.has(String(t.id));
    if (!byId && !todoCoversSlot(c, t, slotMin)) return false;
    if (seenD.has(String(t.id))) return false;
    seenD.add(String(t.id));
    return true;
  });

  return { slot: slot, tasks: tasks, todos: todos, entry: entry };
}

function nextFixedSlot(c, min) {
  const mins = c.fixed.map(function (f) { return hhmm(f.slot_time); })
    .filter(function (v) { return v != null; })
    .sort(function (a, b) { return a - b; });
  const hit = mins.find(function (v) { return v > min; });
  return hit == null ? null : hit;
}

/* ---------- sections ---------- */

function renderTop(c) {
  const p = c.parts;
  const daily = dailyTasks(c);
  const done = daily.filter(function (t) { return isDone(c, t.id); }).length;
  const pct = daily.length ? Math.round(done / daily.length * 100) : 0;
  return {
    date: pad2(p.m) + '/' + pad2(p.d),
    dow: '(' + WEEK[p.dow] + ')',
    done: done,
    total: daily.length,
    xp: c.totalXp,
    pct: pct
  };
}

function renderNow(c) {
  const min = c.now;
  const nx = nextFixedSlot(c, min);
  const nextTxt = nx != null ? slotLabel(nx) : '04:00';
  let label = '지금 할 일', chip = '', mode = 'now', slotMin = null;

  if (min < DAY_FIRST) {
    mode = 'before'; slotMin = DAY_FIRST; label = '다음 할 일';
    chip = slotLabel(slotMin) + '–' + slotLabel(slotMin + 30);
  } else if (min >= DAY_LAST + 30) {
    mode = 'after'; label = '오늘 마무리';
  } else {
    slotMin = Math.floor(min / 30) * 30;
    chip = slotLabel(slotMin) + '–' + slotLabel(slotMin + 30);
  }

  if (mode === 'after') {
    const daily = dailyTasks(c);
    const done = daily.filter(function (t) { return isDone(c, t.id); }).length;
    const left = c.todos.filter(function (t) {
      return t.active !== false && t.todo_date === c.today &&
        ['pending', 'in_progress'].includes(t.status || 'pending');
    }).length;
    const empty = '<b>오늘 완료 ' + done + '/' + daily.length + '</b>' +
      (left ? '<span class="dot">·</span>남은 To-do <b>' + left + '</b>' : '') +
      '<span class="dot">·</span>다음 <b>04:00</b>';
    return { label: label, chip: '', hiddenChip: true, cnt: '', rows: [], empty: empty, hiddenEmpty: false, hiddenList: true };
  }

  const items = slotItems(c, slotMin);
  const rows = [];
  for (const t of items.tasks) rows.push(taskRow(c, t));
  for (const t of items.todos) rows.push(todoRow(c, t));
  const total = rows.length;

  let empty = '';
  if (!total) {
    empty = mode === 'before'
      ? '<b>아직 새벽</b><span class="dot">·</span>04:00 시작'
      : '<b>지금 없음</b><span class="dot">·</span>다음 <b>' + nextTxt + '</b>' + (nx == null ? ' (내일)' : '');
  }

  return {
    label: label,
    chip: chip,
    hiddenChip: !chip,
    cnt: total ? total + '개' : '',
    rows: rows.slice(0, NOW_MAX),
    empty: empty,
    hiddenEmpty: total > 0,
    hiddenList: total === 0
  };
}

function renderTodos(c) {
  const todayAll = c.todos.filter(function (t) { return t.active !== false && t.todo_date === c.today; });
  const doneCnt = todayAll.filter(function (t) { return (t.status || '') === 'completed'; }).length;
  const open = todayAll.filter(function (t) { return ['pending', 'in_progress'].includes(t.status || 'pending'); });
  open.sort(function (a, b) {
    const ua = URGENCY_ORDER[a.urgency || ''] != null ? URGENCY_ORDER[a.urgency || ''] : 9;
    const ub = URGENCY_ORDER[b.urgency || ''] != null ? URGENCY_ORDER[b.urgency || ''] : 9;
    if (ua !== ub) return ua - ub;
    const da = a.due_at ? new Date(a.due_at).getTime() : Number.MAX_SAFE_INTEGER;
    const db = b.due_at ? new Date(b.due_at).getTime() : Number.MAX_SAFE_INTEGER;
    if (da !== db) return da - db;
    return String(a.created_at || '').localeCompare(String(b.created_at || ''));
  });
  const doneRows = todayAll.filter(function (t) { return (t.status || '') === 'completed'; });

  const shown = open.slice(0, TODO_MAX).map(function (t) { return todoRow(c, t); });
  for (const t of doneRows.slice(0, Math.max(0, TODO_MAX - shown.length))) shown.push(todoRow(c, t));

  return {
    cnt: todayAll.length ? doneCnt + '/' + todayAll.length : '',
    rows: shown,
    hiddenList: shown.length === 0,
    hiddenEmpty: shown.length > 0
  };
}

function renderWeek(c) {
  const rows = [];
  const evs = c.events.slice().sort(function (a, b) {
    const da = String(a.event_date || ''), db = String(b.event_date || '');
    if (da !== db) return da < db ? -1 : 1;
    const ta = hhmm(a.start_time), tb = hhmm(b.start_time);
    return (ta == null ? -1 : ta) - (tb == null ? -1 : tb);
  });
  for (const e of evs) {
    const date = String(e.event_date || '').slice(0, 10);
    const p = dateParts(date);
    if (!p) continue;
    const isToday = date === c.today;
    const past = date < c.today;
    const time = e.start_time ? String(e.start_time).slice(0, 5) : '';
    const multi = e.end_date && String(e.end_date).slice(0, 10) !== date ? '~' : '';
    rows.push('<li class="wrow' + (isToday ? ' today' : '') + (past ? ' past' : '') + '"' +
      (past ? ' data-past="1"' : '') + '>' +
      '<span class="wd2">' + pad2(p.m) + '/' + pad2(p.d) + '<em>' + WEEK[p.dow] + '</em></span>' +
      '<span class="wt">' + esc(time) + '</span>' +
      '<span class="wtt">' + esc(multi + (e.title || '')) + '</span></li>');
  }
  const wk = c.week || { start: c.today, end: c.today };
  const a = dateParts(wk.start), b = dateParts(wk.end);
  const range = a && b ? pad2(a.m) + '/' + pad2(a.d) + '–' + pad2(b.m) + '/' + pad2(b.d) : '';
  return {
    cnt: range,
    rows: rows,
    hiddenList: rows.length === 0,
    hiddenEmpty: rows.length > 0
  };
}

function renderMandala(c) {
  const daily = dailyTasks(c);
  const doneAll = daily.filter(function (t) { return isDone(c, t.id); }).length;
  const pctAll = daily.length ? Math.round(doneAll / daily.length * 100) : 0;

  const tiles = [];
  const sheets = [];
  const areas = c.areas.slice(0, 8);
  let ai = 0;
  for (let i = 0; i < 9; i++) {
    if (i === 4) { tiles.push(coreTile(c, pctAll)); continue; }
    const a = areas[ai];
    tiles.push(areaTile(c, a, ai, daily));
    if (a) sheets.push(areaSheet(c, a, ai, daily));
    ai++;
  }

  return {
    cnt: pctAll + '% · ' + doneAll + '/' + daily.length,
    cells: tiles.join(''),
    sheets: sheets.join('')
  };
}

/* 가운데 完璧超人 칸 */
function coreTile(c, pct) {
  const chars = String(c.core || '完璧超人').replace(/\s/g, '').slice(0, 4);
  let cb = '';
  for (let i = 0; i < 4; i++) cb += '<span>' + esc(chars[i] || '') + '</span>';
  return '<div class="ar core"><div class="cc"><div class="cb">' + cb + '</div>' +
    '<b class="p2">' + pct + '%</b></div></div>';
}

/* 영역 한 칸 = 3×3 미니 그리드 (가운데: 영역 한자 + 오늘 달성, 주변 8칸: 세부 과업) */
function areaTile(c, a, index, daily) {
  if (!a) return '<div class="ar"><span class="mi e"></span></div>';
  const list = daily.filter(function (t) { return String(t.area_id) === String(a.id); });
  const done = list.filter(function (t) { return isDone(c, t.id); }).length;
  const color = AREA_COLORS[index % AREA_COLORS.length];
  const tasks = list.slice(0, 8);
  const parts = [];
  for (let p = 0; p < 9; p++) {
    if (p === 4) {
      parts.push('<button type="button" class="mi ctr" style="--c:' + color + '" data-area="' + esc(a.id) + '"' +
        ' aria-label="' + esc(a.name + ' ' + done + '/' + list.length + ' 세부 과업 열기') + '">' +
        '<b class="hz">' + esc(a.name) + '</b>' +
        '<i class="n">' + done + '/' + list.length + '</i></button>');
      continue;
    }
    const t = tasks[p < 4 ? p : p - 1];
    if (!t) { parts.push('<span class="mi e"></span>'); continue; }
    const d = isDone(c, t.id);
    parts.push('<button type="button" class="mi t' + (d ? ' done' : '') + '" style="--c:' + color + '"' +
      ' data-k="task" data-id="' + esc(t.id) + '" data-xp="' + Math.round(Number(t.xp) || 0) + '"' +
      ' data-area="' + esc(a.id) + '" aria-pressed="' + (d ? 'true' : 'false') + '"' +
      ' aria-label="' + esc(a.name + ' ' + t.name + (d ? ' 완료' : '')) + '">' +
      '<span>' + esc(String(t.name || '').replace(/\s+/g, ' ').trim()) + '</span></button>');
  }
  return '<div class="ar" data-a="' + esc(a.id) + '">' + parts.join('') + '</div>';
}

function areaSheet(c, a, index, daily) {
  const color = AREA_COLORS[index % AREA_COLORS.length];
  const list = daily.filter(function (t) { return t.area_id === a.id; });
  const done = list.filter(function (t) { return isDone(c, t.id); }).length;
  const rows = list.map(function (t) { return taskRow(c, t); }).join('');
  return '<div class="sh" id="sh-' + esc(a.id) + '" data-area="' + esc(a.id) + '" hidden>' +
    '<div class="shTop"><span class="han big" style="--c:' + color + '">' + esc(a.name) + '</span>' +
    '<span class="shName">' + esc(a.name) + ' 과업</span>' +
    '<span class="shCnt">' + done + '/' + list.length + '</span>' +
    '<button type="button" class="shX" data-close="1" aria-label="닫기">✕</button></div>' +
    '<ul class="list sheetList">' + rows + '</ul></div>';
}

/* ---------- styles ---------- */

const CSS = [
'/* 4단 위젯: 카드는 내용 높이만큼만 차지하고, 남는 높이는 9×9 만다라트가 흡수한다 */',
':root{',
'  --bg:#0a0e14; --card:#151c26; --card2:#18202b; --line:#232e3b; --line2:#2b3644;',
'  --text:#f2f6fb; --muted:#93a2b6; --dim:#7f8fa3;',
'  --accent:#8fa4ff; --accent2:#b58cff; --good:#4fd8a4; --danger:#ff7d88;',
'  --top:max(36px,10.5vh); --gap:5px; --cpad:5px; --rgap:3px; --rh:25px; --wh:21px; --hh:14px; --agap:3px;',
'  --rfont:12.5px; --hfont:9.5px; --sfont:8.5px; --mfont:8px; --mini:18px; --w1:38px; --w2:32px;',
'}',
'html.dense{--top:max(34px,10.5vh);--gap:4px;--cpad:4px;--rgap:2px;--rh:23px;--wh:19px;--hh:13px;--agap:3px;--rfont:12px;--hfont:9px;--sfont:8px;--mfont:7.6px;--mini:16px;--w1:36px;--w2:30px}',
'html.denser{--top:max(32px,10.5vh);--gap:3px;--cpad:3px;--rgap:2px;--rh:20px;--wh:17px;--hh:12px;--agap:2px;--rfont:11.5px;--hfont:8.5px;--sfont:7.5px;--mfont:7.2px;--mini:14px;--w1:34px;--w2:28px}',
'html.ultra{--top:max(30px,10.5vh);--gap:2px;--cpad:2px;--rgap:1px;--rh:16px;--wh:16px;--hh:9px;--agap:2px;--rfont:10.5px;--hfont:8px;--sfont:7px;--mfont:6.8px;--mini:12px;--w1:36px;--w2:27px}',
'*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}',
'html,body{margin:0;padding:0;height:100%}',
'body{background:radial-gradient(120% 55% at 50% 0%,#17202c 0%,#0a0e14 58%,#080b10 100%);',
'  color:var(--text);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans KR",sans-serif;',
'  min-height:100vh;min-height:100dvh;font-size:13px;-webkit-text-size-adjust:100%;overflow:hidden;',
'  -webkit-user-select:none;user-select:none;overscroll-behavior:none}',
'[hidden]{display:none!important}',
'button{font-family:inherit;border:0;margin:0;color:inherit;background:none;padding:0;text-align:left}',
'/* 상단 --top 은 런처 시간 배지·새로고침 아이콘 자리를 비워 두는 여백이다 */',
'.wrap{max-width:520px;margin:0 auto;height:100vh;height:100dvh;min-height:100vh;min-height:100dvh;',
'  display:flex;flex-direction:column;gap:var(--gap);padding:var(--top) 7px calc(3px + env(safe-area-inset-bottom));overflow:hidden}',
'.top{flex:none;display:flex;align-items:center;gap:6px;padding:0 1px 2px;min-width:0}',
'.dt{flex:none;font-size:15px;font-weight:800;letter-spacing:.2px;font-variant-numeric:tabular-nums;line-height:1.1}',
'.dt .wd{font-size:10px;font-weight:700;color:var(--muted);margin-left:2px}',
'.stat{margin-left:auto;min-width:0;font-size:10.5px;color:#b7c4d6;white-space:nowrap;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis}',
'.stat b{color:#fff;font-size:11.5px;font-weight:800}',
'.stat .dot{color:#55637a;margin:0 3px}',
'.track{flex:none;height:3px;background:#111823;border:1px solid #1c2531;border-radius:99px;overflow:hidden;margin:0 1px}',
'.track i{display:block;height:100%;width:0;border-radius:99px;',
'  background:linear-gradient(90deg,var(--accent),var(--accent2));transition:width .35s ease}',
'.card{flex:0 0 auto;display:flex;flex-direction:column;overflow:hidden;',
'  background:linear-gradient(180deg,var(--card),#121821);border:1px solid var(--line);',
'  border-radius:12px;padding:var(--cpad);box-shadow:0 6px 16px #00000026}',
'#secM{flex:1 1 auto;min-height:0}',
'.head{flex:none;height:var(--hh);display:flex;align-items:center;gap:5px;margin:0 1px 2px;min-width:0;overflow:hidden}',
'.label{font-size:var(--hfont);font-weight:800;letter-spacing:.08em;color:var(--accent);white-space:nowrap;flex:none}',
'.chip{flex:none;font-size:8px;font-weight:700;line-height:10px;color:#cfdaea;background:#1d2733;border:1px solid var(--line2);',
'  border-radius:5px;padding:0 3px;font-variant-numeric:tabular-nums;white-space:nowrap}',
'.cnt{margin-left:auto;min-width:0;font-size:8.5px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.list{list-style:none;margin:0;padding:0;flex:0 1 auto;min-height:0;display:flex;flex-direction:column;gap:var(--rgap);overflow:hidden}',
'.row{position:relative;display:flex;align-items:center;gap:4px;flex:0 0 auto;height:var(--rh);',
'  padding:0 4px 0 3px;border-radius:7px;background:var(--card2);border-left:2px solid #2c3746;min-width:0;overflow:hidden}',
'.row:active{background:#202b38}',
'.row.u-top{border-left-color:#ff7d88}',
'.row.u-a{border-left-color:#ffc75f}',
'.row.u-b{border-left-color:#59c8f5}',
'.row.u-c{border-left-color:#8fa0b5}',
'.row.done{opacity:.55}',
'.box{flex:none;width:11px;height:11px;border-radius:3.5px;border:1.5px solid #46556b;background:#0e141c;position:relative}',
'.row.done .box{background:var(--good);border-color:var(--good)}',
'.row.done .box::after{content:"";position:absolute;left:2.5px;top:0.5px;width:3px;height:6px;',
'  border-right:1.6px solid #08110d;border-bottom:1.6px solid #08110d;transform:rotate(40deg)}',
'.main{min-width:0;flex:1;display:flex;flex-direction:column;justify-content:center}',
'.title{font-size:var(--rfont);font-weight:700;letter-spacing:-.1px;line-height:1.16;',
'  overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
'.row.done .title{opacity:.75;text-decoration:line-through}',
'.sub{font-size:var(--sfont);color:#8fa0b5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
'  font-variant-numeric:tabular-nums;line-height:1.1}',
'html.denser .row .sub,html.ultra .row .sub{display:none}',
'.han{display:inline-grid;place-items:center;width:13px;height:13px;border-radius:4px;margin-right:3px;',
'  font-size:8.5px;font-weight:700;color:#0b0f14;background:var(--c,#8fa4ff);vertical-align:1px;',
'  font-family:"Noto Serif KR","HYhaeseo",serif}',
'.han.big{width:16px;height:16px;font-size:10px;margin-right:0}',
'.empty{flex:0 0 auto;height:var(--rh);display:flex;align-items:center;justify-content:center;gap:2px;',
'  font-size:10.5px;color:var(--dim);white-space:nowrap;overflow:hidden;font-variant-numeric:tabular-nums}',
'.empty b{color:#cfdaea;font-weight:800}',
'.empty .dot{color:#4a5768}',
'/* 이번 주 캘린더 */',
'.week{overflow:hidden}',
'.wrow{flex:0 0 auto;height:var(--wh);display:grid;grid-template-columns:var(--w1) var(--w2) minmax(0,1fr);',
'  align-items:center;gap:3px;padding:0 3px;border-radius:6px;border-left:2px solid transparent;',
'  font-size:var(--rfont);line-height:1.1;overflow:hidden}',
'.wrow.today{background:#1b2532;border-left-color:var(--accent)}',
'.wrow.today .wd2{color:#dfe8f8}',
'.wrow.past{opacity:.5}',
'.wd2{font-size:9.5px;font-weight:800;color:#a9b8cc;font-variant-numeric:tabular-nums;white-space:nowrap;',
'  font-family:system-ui,sans-serif}',
'.wd2 em{font-style:normal;font-size:8px;font-weight:700;color:#7d8ca0;margin-left:1px}',
'.wrow.today .wd2 em{color:var(--accent)}',
'.wt{font-size:9px;color:#8fa0b5;font-variant-numeric:tabular-nums;white-space:nowrap}',
'.wtt{font-size:var(--rfont);font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;letter-spacing:-.1px}',
'html.ultra .wrow{grid-template-columns:var(--w1) minmax(0,1fr)}',
'html.ultra .wrow .wt{display:none}',
'html.ultra .track{display:none}',
'/* 만다라트 9×9: 영역 3×3 안에 세부 과업 8개 + 가운데 영역 칸 */',
'.m9{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));',
'  grid-template-rows:repeat(3,minmax(0,1fr));gap:var(--agap)}',
'.ar{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(3,minmax(0,1fr));',
'  gap:1px;min-width:0;min-height:0;padding:1px;border-radius:6px;background:#0e141c;',
'  border:1px solid var(--line);overflow:hidden}',
'.mi{min-width:0;min-height:0;overflow:hidden;border-radius:3px;background:#151d27;color:#8d9db1;',
'  font-size:var(--mfont);font-weight:700;line-height:1.06;padding:1px;display:flex;align-items:center;justify-content:center;',
'  text-align:center;word-break:keep-all;overflow-wrap:anywhere;letter-spacing:-.2px}',
'.mi>span{display:block;max-width:100%;max-height:2.15em;overflow:hidden;word-break:break-all;text-align:center}',
'.mi.done{background:var(--c,#8fa4ff);color:#07111a;font-weight:800}',
'.mi.e{background:#10161e}',
'.mi.ctr{flex-direction:column;justify-content:center;gap:0;background:#1a2330;border:1px solid var(--c,#3c4a5e)}',
'.mi.ctr .hz{font-family:"Noto Serif KR","HYhaeseo",serif;font-size:calc(var(--mfont) + 1.5px);line-height:1;color:var(--c,#8fa4ff)}',
'.mi.ctr .n{font-style:normal;font-size:calc(var(--mfont) - .3px);color:#cfdaea;line-height:1.05}',
'.ar.core{background:linear-gradient(150deg,#2b2452,#1a2233 70%);border-color:#3c3a6e;display:flex;align-items:center;justify-content:center}',
'.cc{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px}',
'.cc .cb{display:grid;grid-template-columns:auto auto;column-gap:1px;line-height:1;font-weight:700;',
'  font-family:"Noto Serif KR","HYhaeseo",serif;font-size:calc(var(--mfont) + 1px);color:#e9e4ff;text-align:center}',
'.cc .p2{font-size:calc(var(--mfont) + 1.5px);font-weight:900;color:#fff;line-height:1;font-variant-numeric:tabular-nums}',
'@media (min-height:520px){.m9{--mfont:8px}}',
'@media (min-height:700px){.m9{--mfont:9px}}',
'/* 영역 시트 */',
'.sheetWrap{position:fixed;inset:0;z-index:30;background:#050810cc;display:flex;align-items:flex-end}',
'.sh{width:100%;max-height:86vh;overflow:auto;background:linear-gradient(180deg,#18202c,#111823);',
'  border-top:1px solid #33415a;border-radius:14px 14px 0 0;padding:7px 8px calc(8px + env(safe-area-inset-bottom))}',
'.shTop{display:flex;align-items:center;gap:5px;margin-bottom:5px}',
'.shName{font-size:11px;font-weight:800;white-space:nowrap}',
'.shCnt{font-size:10px;color:var(--muted);font-variant-numeric:tabular-nums}',
'.shX{margin-left:auto;width:20px;height:20px;border-radius:50%;background:#26313f;color:#cfdaea;',
'  display:grid;place-items:center;font-size:11px}',
'.sheetList{overflow:visible}',
'.sheetList .row{flex:none;min-height:26px;height:auto}',
'.toast{position:fixed;left:50%;bottom:12px;transform:translate(-50%,20px);z-index:40;opacity:0;',
'  padding:6px 12px;border-radius:99px;background:#e8eef7;color:#0a0e16;font-size:11.5px;font-weight:800;',
'  transition:opacity .18s ease,transform .18s ease;pointer-events:none;white-space:nowrap}',
'.toast.show{opacity:1;transform:translate(-50%,0)}',
'body.err{display:grid;place-items:center;min-height:100dvh;padding:14px;overflow:auto}',
'.errbox{max-width:420px;width:100%;background:linear-gradient(180deg,var(--card),#121821);',
'  border:1px solid #5a2230;border-radius:13px;padding:12px 13px}',
'.errbox .t{font-size:10px;letter-spacing:.16em;font-weight:800;color:var(--danger)}',
'.errbox .m{margin-top:6px;font-size:12.5px;line-height:1.5;color:#e8eef7;word-break:break-word}',
'.errbox .m b{color:#fff}',
'.errbox button{margin-top:10px;border:0;border-radius:9px;padding:7px 13px;font-size:12px;font-weight:800;',
'  color:#0a0e16;background:linear-gradient(90deg,var(--accent),var(--accent2))}'
].join('\n');

/* ---------- client script ---------- */

const CLIENT_SCRIPT = [
'(function(){',
'  "use strict";',
'  var app=document.getElementById("app");',
'  if(!app) return;',
'  var html=document.documentElement;',
'  var statEl=document.getElementById("kStat");',
'  var barEl=document.getElementById("bar");',
'  var mCnt=document.getElementById("mCnt");',
'  var toastEl=document.getElementById("toast");',
'  var sheetWrap=document.getElementById("sheetWrap");',
'  var S={done:+app.getAttribute("data-done")||0,total:+app.getAttribute("data-total")||0,xp:+app.getAttribute("data-xp")||0};',
'  var busy={};',
'  var KEY=(function(){var m=/[?&]key=([^&]*)/.exec(location.search);return m?decodeURIComponent(m[1]):"";})();',
'  var ENDPOINT="/api/widget/toggle";',
'  var toastT=null;',
'',
'  function fmt(n){n=Math.round(+n||0);return String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g,",");}',
'  function each(sel,fn){var a=document.querySelectorAll(sel);for(var i=0;i<a.length;i++)fn(a[i]);}',
'  function toast(msg){',
'    if(!toastEl)return;',
'    toastEl.textContent=msg;toastEl.className="toast show";',
'    clearTimeout(toastT);toastT=setTimeout(function(){toastEl.className="toast";},1300);',
'  }',
'  function pctDone(){return S.total?Math.round(S.done/S.total*100):0;}',
'  function paintStat(){',
'    if(statEl) statEl.innerHTML="<b>"+S.done+"/"+S.total+"</b><span class=dot>·</span><b>"+fmt(S.xp)+" XP</b>";',
'    if(barEl) barEl.style.width=pctDone()+"%";',
'    if(mCnt) mCnt.textContent=pctDone()+"% · "+S.done+"/"+S.total;',
'    var cp=document.querySelector(".cc .p2");',
'    if(cp) cp.textContent=pctDone()+"%";',
'  }',
'  function paintTodoCnt(){',
'    var el=document.getElementById("todoCnt");',
'    if(!el)return;',
'    var rows=document.querySelectorAll("#todoList .row");',
'    if(!rows.length)return;',
'    var all=S.todoAll||rows.length,done=0;',
'    for(var i=0;i<rows.length;i++) if(rows[i].className.indexOf("done")>=0) done++;',
'    el.textContent=done+"/"+all;',
'  }',
'  function rowsOf(k,id){return document.querySelectorAll(\'[data-k="\'+k+\'"][data-id="\'+id+\'"]\');}',
'  function setRow(el,done){',
'    if(done){ if(el.className.indexOf("done")<0) el.className+=" done"; }',
'    else { el.className=el.className.replace(/\\s*done/g,""); }',
'    el.setAttribute("aria-pressed",done?"true":"false");',
'  }',
'  function paintArea(aid){',
'    var ar=document.querySelector(\'.ar[data-a="\'+aid+\'"]\');',
'    if(!ar)return;',
'    var ts=ar.querySelectorAll(".mi[data-k]"),d=0;',
'    for(var i=0;i<ts.length;i++) if(ts[i].className.indexOf("done")>=0) d++;',
'    var n=ar.querySelector(".ctr .n");',
'    if(n) n.textContent=d+"/"+ts.length;',
'    var sh=document.getElementById("sh-"+aid),sc=sh?sh.querySelector(".shCnt"):null;',
'    if(sc) sc.textContent=d+"/"+ts.length;',
'  }',
'  function delta(k,done,xp,area){',
'    var sign=done?1:-1;',
'    if(k==="task") S.done+=sign;',
'    S.xp+=sign*xp;',
'    paintStat();',
'    if(k==="task"&&area) paintArea(area);',
'    if(k!=="task") paintTodoCnt();',
'  }',
'  function toggle(li){',
'    var k=li.getAttribute("data-k"),id=li.getAttribute("data-id");',
'    if(!k||!id)return;',
'    var guard=k+":"+id;',
'    if(busy[guard])return;',
'    var wasDone=li.className.indexOf("done")>=0;',
'    var next=!wasDone;',
'    var xp=+li.getAttribute("data-xp")||0;',
'    var area=li.getAttribute("data-area")||"";',
'    var prev=li.getAttribute("data-prev")||"in_progress";',
'    var list=rowsOf(k,id);',
'    for(var i=0;i<list.length;i++) setRow(list[i],next);',
'    delta(k,next,xp,area);',
'    busy[guard]=1;',
'    var body=k==="task"?{type:"task",taskId:id,completed:next}',
'                        :{type:"todo",id:id,completed:next,prevStatus:prev};',
'    post(body).then(function(j){',
'      delete busy[guard];',
'      if(j && typeof j.xpDelta==="number" && j.xpDelta!==(next?xp:-xp)){',
'        S.xp+=j.xpDelta-(next?xp:-xp);paintStat();',
'      }',
'      toast(next?("완료 · +"+xp+" XP"):"완료 취소");',
'    })["catch"](function(){',
'      delete busy[guard];',
'      for(var i2=0;i2<list.length;i2++) setRow(list[i2],wasDone);',
'      delta(k,!next,xp,area);',
'      toast("저장 실패 · 다시 시도");',
'    });',
'  }',
'  function post(body){',
'    return fetch(ENDPOINT+"?key="+encodeURIComponent(KEY),{',
'      method:"POST",cache:"no-store",',
'      headers:{"Content-Type":"application/json"},',
'      body:JSON.stringify(body)',
'    }).then(function(r){',
'      return r.json().then(function(j){',
'        if(!r.ok||!j||j.ok!==true) throw new Error((j&&j.error)||("HTTP "+r.status));',
'        return j;',
'      });',
'    });',
'  }',
'  function openSheet(aid){',
'    var sh=document.getElementById("sh-"+aid);',
'    if(!sh||!sheetWrap)return;',
'    each(".sh",function(x){x.hidden=true;});',
'    sh.hidden=false;',
'    sheetWrap.hidden=false;',
'  }',
'  function closeSheet(){',
'    if(!sheetWrap)return;',
'    sheetWrap.hidden=true;',
'    each(".sh",function(x){x.hidden=true;});',
'  }',
'  document.addEventListener("click",function(ev){',
'    var t=ev.target;',
'    if(!t||!t.closest)return;',
'    if(t.closest("[data-close]")){ev.preventDefault();closeSheet();return;}',
'    var row=t.closest("[data-k]");',
'    if(row){ev.preventDefault();toggle(row);return;}',
'    var ctr=t.closest(".mi.ctr");',
'    if(ctr){ev.preventDefault();openSheet(ctr.getAttribute("data-area"));return;}',
'    if(sheetWrap&&!sheetWrap.hidden&&t===sheetWrap){closeSheet();}',
'  },false);',
'  document.addEventListener("keydown",function(ev){',
'    if(ev.key==="Escape"){closeSheet();return;}',
'    if(ev.key==="Enter"||ev.key===" "){',
'      var row=ev.target&&ev.target.closest?ev.target.closest("[data-k]"):null;',
'      if(row){ev.preventDefault();toggle(row);}',
'    }',
'  },false);',
'',
'  /* ---- 높이 맞춤: 네 섹션은 항상 남기고, 넘칠 때만 To-do·캘린더를 번갈아 줄인다 ---- */',
'  var nowList=document.getElementById("nowList"),todoList=document.getElementById("todoList"),weekList=document.getElementById("weekList");',
'  var m9=document.getElementById("m9");',
'  var MIN_TODO=3,MIN_WEEK=2;',
'  function kids(el){return el?[].slice.call(el.children):[];}',
'  function shown(el){return kids(el).filter(function(x){return !x.hidden;});}',
'  function cssNum(n){return parseFloat(getComputedStyle(html).getPropertyValue(n))||0;}',
'  function tight(){',
'    if(!m9)return false;',
'    /* 카드는 내용 높이로만 커지고 남는 높이는 만다라트가 받으므로, 만다라트가 9줄을 그릴',
'       높이를 갖지 못하면(= 다른 섹션이 자리를 다 먹으면) 넘친 상태다. */',
'    var cs=getComputedStyle(app);',
'    var av=app.clientHeight-(parseFloat(cs.paddingTop)||0)-(parseFloat(cs.paddingBottom)||0);',
'    var need=Math.max(9*cssNum("--mini")+2*cssNum("--agap")+8,av*0.43);',
'    return m9.getBoundingClientRect().height+0.5<need;',
'  }',
'  function dropWeek(w,min){',
'    var t=null;',
'    if(w.length>min){',
'      for(var i=0;i<w.length;i++){if(w[i].getAttribute("data-past")==="1"){t=w[i];break;}}',
'    }',
'    if(!t)t=w[w.length-1];',
'    t.hidden=true;',
'  }',
'  var turn=0;',
'  function dropOne(tMin,wMin){',
'    var w=shown(weekList),t=shown(todoList),n=shown(nowList),opts=[];',
'    if(w.length>wMin)opts.push("w");',
'    if(t.length>tMin)opts.push("t");',
'    if(n.length>1)opts.push("n");',
'    if(!opts.length)return false;',
'    var want=turn%2?"t":"w",pick=opts[0];',
'    for(var i=0;i<opts.length;i++){if(opts[i]===want){pick=want;break;}}',
'    if(pick==="w") dropWeek(w,wMin);',
'    else if(pick==="t") t[t.length-1].hidden=true;',
'    else n[n.length-1].hidden=true;',
'    turn++;',
'    return true;',
'  }',
'  function resetRows(){',
'    var a=[].concat(kids(nowList),kids(todoList),kids(weekList));',
'    for(var i=0;i<a.length;i++) a[i].hidden=false;',
'  }',
'  function fitLevel(tMin,wMin,wMax){',
'    var w=shown(weekList);',
'    while(w.length>wMax){dropWeek(w,wMax);w=shown(weekList);}',
'    turn=0;',
'    for(var g=0;g<80&&tight();g++){if(!dropOne(tMin,wMin))break;}',
'    return !tight();',
'  }',
'  function tuneFont(){',
'    if(!m9)return;',
'    var row=(m9.getBoundingClientRect().height-2*cssNum("--agap")-6)/9;',
'    var f=Math.max(6,Math.min(9,row*0.38));',
'    m9.style.setProperty("--mfont",f.toFixed(1)+"px");',
'  }',
'  function fit(){',
'    var levels=["","dense","denser","ultra"];',
'    for(var i=0;i<levels.length;i++){',
'      html.className=levels[i];',
'      resetRows();',
'      if(fitLevel(MIN_TODO,MIN_WEEK,4)){tuneFont();return;}',
'    }',
'    html.className="ultra";',
'    resetRows();',
'    if(fitLevel(2,1,3)){tuneFont();return;}',
'    resetRows();',
'    fitLevel(1,1,2);',
'    if(window.scrollY)window.scrollTo(0,0);',
'    tuneFont();',
'  }',
'  S.todoAll=(function(){var a=document.querySelectorAll("#todoList .row");var d=0;',
'    for(var i=0;i<a.length;i++) if(a[i].className.indexOf("done")>=0) d++;',
'    S.todoDone=d;return a.length;})();',
'  paintTodoCnt();',
'  window.addEventListener("resize",fit);',
'  window.addEventListener("orientationchange",fit);',
'  setTimeout(fit,0);setTimeout(fit,80);setTimeout(fit,320);',
'  if(document.fonts&&document.fonts.ready){document.fonts.ready.then(fit)["catch"](function(){});}',
'})();'
].join('\n');

/* ---------- pages ---------- */

function head(title) {
  return '<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' +
    '<meta name="theme-color" content="#0a0e14">\n' +
    '<meta name="referrer" content="no-referrer">\n' +
    '<meta name="robots" content="noindex,nofollow">\n' +
    '<title>' + title + '</title>\n<style>\n' + CSS + '\n</style>\n</head>\n';
}

function widgetHtml(c) {
  const top = renderTop(c);
  const now = renderNow(c);
  const todos = renderTodos(c);
  const week = renderWeek(c);
  const mandala = renderMandala(c);

  return head('MANDALA · 지금') +
    '<body>\n<main class="wrap" id="app" data-done="' + top.done + '" data-total="' + top.total + '" data-xp="' + top.xp + '">\n' +
    '  <header class="top">\n' +
    '    <div class="dt"><span id="kDate">' + top.date + '</span><span class="wd" id="kDow">' + top.dow + '</span></div>\n' +
    '    <div class="stat" id="kStat"><b>' + top.done + '/' + top.total + '</b><span class="dot">·</span><b>' + fmtNum(top.xp) + ' XP</b></div>\n' +
    '  </header>\n' +
    '  <div class="track"><i id="bar" style="width:' + top.pct + '%"></i></div>\n' +
    '\n' +
    '  <section class="card" id="secNow">\n' +
    '    <div class="head">\n' +
    '      <span class="label" id="nowLabel">' + esc(now.label) + '</span>\n' +
    '      <span class="chip" id="nowSlotTag"' + (now.hiddenChip ? ' hidden' : '') + '>' + esc(now.chip) + '</span>\n' +
    '      <span class="cnt" id="nowCnt">' + esc(now.cnt) + '</span>\n' +
    '    </div>\n' +
    '    <ul class="list" id="nowList"' + (now.hiddenList ? ' hidden' : '') + '>' + now.rows.join('') + '</ul>\n' +
    '    <div class="empty" id="nowEmpty"' + (now.hiddenEmpty ? ' hidden' : '') + '>' + now.empty + '</div>\n' +
    '  </section>\n' +
    '\n' +
    '  <section class="card" id="secTodo">\n' +
    '    <div class="head">\n' +
    '      <span class="label">오늘 To-do</span>\n' +
    '      <span class="cnt" id="todoCnt">' + esc(todos.cnt) + '</span>\n' +
    '    </div>\n' +
    '    <ul class="list" id="todoList"' + (todos.hiddenList ? ' hidden' : '') + '>' + todos.rows.join('') + '</ul>\n' +
    '    <div class="empty" id="todoEmpty"' + (todos.hiddenEmpty ? ' hidden' : '') + '>오늘 To-do 없음</div>\n' +
    '  </section>\n' +
    '\n' +
    '  <section class="card" id="secWeek">\n' +
    '    <div class="head">\n' +
    '      <span class="label">이번 주 캘린더</span>\n' +
    '      <span class="cnt" id="weekCnt">' + esc(week.cnt) + '</span>\n' +
    '    </div>\n' +
    '    <ul class="list week" id="weekList"' + (week.hiddenList ? ' hidden' : '') + '>' + week.rows.join('') + '</ul>\n' +
    '    <div class="empty" id="weekEmpty"' + (week.hiddenEmpty ? ' hidden' : '') + '>이번 주 일정 없음</div>\n' +
    '  </section>\n' +
    '\n' +
    '  <section class="card" id="secM">\n' +
    '    <div class="head">\n' +
    '      <span class="label">만다라트</span>\n' +
    '      <span class="cnt" id="mCnt">' + esc(mandala.cnt) + '</span>\n' +
    '    </div>\n' +
    '    <div class="m9" id="m9">' + mandala.cells + '</div>\n' +
    '  </section>\n' +
    '</main>\n' +
    '<div class="sheetWrap" id="sheetWrap" hidden>' + mandala.sheets + '</div>\n' +
    '<div class="toast" id="toast"></div>\n' +
    '<script>\n' + CLIENT_SCRIPT + '\n</script>\n' +
    '</body>\n</html>\n';
}

function errorHtml(status, title, message) {
  return head('MANDALA · 위젯') +
    '<body class="err">\n<div class="errbox">\n' +
    '  <div class="t">MANDALA · ' + status + '</div>\n' +
    '  <div class="m"><b>' + esc(title) + '</b><br>' + message + '</div>\n' +
    '  <button type="button" onclick="location.reload()">다시 시도</button>\n' +
    '</div>\n</body>\n</html>\n';
}

/* ---------- handler ---------- */

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const method = String((req && req.method) || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).send(errorHtml(405, '지원하지 않는 요청입니다', 'GET 요청만 사용할 수 있습니다.'));
  }

  const cfg = getConfig();
  if (!cfg.widgetKey) {
    return res.status(500).send(errorHtml(500, '위젯 키가 서버에 없습니다',
      'Vercel 환경변수 <b>WIDGET_KEY</b> 를 설정한 뒤 다시 배포해 주세요.'));
  }
  if (!cfg.serviceKey) {
    return res.status(500).send(errorHtml(500, '데이터베이스 키가 서버에 없습니다',
      'Vercel 환경변수 <b>SUPABASE_SERVICE_ROLE_KEY</b> 를 설정한 뒤 다시 배포해 주세요.'));
  }

  const verdict = checkKey(req);
  if (verdict === 'missing_config') {
    return res.status(500).send(errorHtml(500, '위젯 설정이 비어 있습니다',
      'Vercel 환경변수 <b>WIDGET_KEY</b> / <b>SUPABASE_SERVICE_ROLE_KEY</b> 를 확인해 주세요.'));
  }
  if (verdict === 'invalid') {
    return res.status(401).send(errorHtml(401, '위젯 키가 올바르지 않습니다',
      'URL의 <b>key</b> 값을 확인해 주세요.'));
  }

  try {
    const data = await fetchWidgetData();
    const ctx = buildCtx(data);
    const html = widgetHtml(ctx);
    if (method === 'HEAD') {
      res.setHeader('Content-Length', Buffer.byteLength(html));
      return res.status(200).end();
    }
    return res.status(200).send(html);
  } catch (e) {
    console.error('[api/widget-html] failed:', (e && e.message) || e);
    return res.status(502).send(errorHtml(502, '오늘 기록을 불러오지 못했습니다',
      '데이터베이스 응답이 없습니다. 잠시 후 새로고침해 주세요.'));
  }
};
