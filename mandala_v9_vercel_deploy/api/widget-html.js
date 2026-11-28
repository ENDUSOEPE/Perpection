'use strict';

/**
 * GET /widget?key=<WIDGET_KEY>  →  vercel.json rewrite  →  /api/widget-html
 *
 * 서버 완성형(SSR) 위젯.
 * 서버가 Supabase 에서 오늘(Asia/Seoul) 데이터를 읽어 widget.html 과 같은
 * 2단 컴팩트 레이아웃(지금 할 일 + TOP TO-DO | 3×3 만다라트)의 완성된 HTML 을 한 번에 돌려준다.
 * JS 가 실행되지 않아도 날짜·XP·지금 할 일·TOP TO-DO·만다라트가 모두 채워져 있다.
 * 인라인 스크립트는 화면 높이에 맞춰 밀도를 낮추는 일만 담당한다.
 * 읽기 전용이므로 체크박스·XP 배지·새로고침 버튼·하단 링크는 두지 않는다.
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
const TODO_MAX = 4;
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

function rowHtml(kind, id, done, titleInner, subText, urgency) {
  const u = URGENCY_CLASS[urgency || ''] || '';
  return '<li class="row' + (done ? ' done' : '') + (u ? ' u-' + u : '') + '" data-kind="' + kind +
    '" data-id="' + esc(id) + '"><div class="main"><div class="title">' + titleInner + '</div>' +
    (subText ? '<div class="sub">' + subText + '</div>' : '') + '</div></li>';
}

function taskRow(c, t) {
  const a = t.area_id != null ? c.areaById.get(String(t.area_id)) : null;
  const subs = [];
  for (const w of workoutsForTask(c, t)) {
    const sets = calcSets(w.max_value);
    if (!sets.length) continue;
    const total = sets.reduce(function (x, y) { return x + y; }, 0);
    const nm = String(w.name).replace(/^\([^)]*\)\s*/, '');
    subs.push(esc(nm) + ' ' + sets.join('·') + ' (총 ' + total + ')');
  }
  return rowHtml('task', t.id, isDone(c, t.id),
    (a ? '<span class="han" style="--c:' + areaColor(c, a) + '">' + esc(a.name) + '</span>' : '') + esc(t.name),
    subs.join('  /  '), '');
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

function todoRow(c, t, withPri) {
  const done = (t.status || 'pending') === 'completed';
  const due = dueLabel(c, t);
  return rowHtml('todo', t.id, done, esc(t.title), esc(due), withPri ? t.urgency : '');
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
    stat: '<b>' + done + '/' + daily.length + '</b><span class="dot">·</span><b>' + fmtNum(c.totalXp) + ' XP</b>',
    barWidth: pct
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
  for (const t of items.todos) rows.push(todoRow(c, t, true));
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

  const shown = open.slice(0, TODO_MAX);
  let cnt = todayAll.length ? doneCnt + '/' + todayAll.length : '';
  if (open.length > shown.length) cnt = doneCnt + '/' + todayAll.length + ' · +' + (open.length - shown.length);

  return {
    cnt: cnt,
    rows: shown.map(function (t) { return todoRow(c, t, true); }),
    hiddenList: shown.length === 0,
    hiddenEmpty: shown.length > 0
  };
}

function renderMandala(c) {
  const daily = dailyTasks(c);
  const doneAll = daily.filter(function (t) { return isDone(c, t.id); }).length;
  const pctAll = daily.length ? Math.round(doneAll / daily.length * 100) : 0;

  const cells = [];
  const areas = c.areas.slice(0, 8);
  let ai = 0;
  for (let i = 0; i < 9; i++) {
    if (i === 4) { cells.push(coreCell(c, pctAll, doneAll, daily.length)); continue; }
    cells.push(areaCell(c, areas[ai], ai, daily));
    ai++;
  }

  return {
    cnt: pctAll + '% · ' + doneAll + '/' + daily.length,
    cells: cells.join('')
  };
}

function coreCell(c, pct, done, total) {
  const chars = String(c.core || '完璧超人').replace(/\s/g, '').slice(0, 4);
  let cb = '';
  for (let i = 0; i < 4; i++) cb += '<span>' + esc(chars[i] || '') + '</span>';
  return '<div class="mc core" title="' + esc(c.core + ' · 오늘 ' + pct + '% (' + done + '/' + total + ')') + '">' +
    '<div class="cb">' + cb + '</div><div class="pct2">' + pct + '%</div></div>';
}

function areaCell(c, a, index, daily) {
  if (!a) return '<div class="mc"></div>';
  const list = daily.filter(function (t) { return t.area_id === a.id; });
  const done = list.filter(function (t) { return isDone(c, t.id); }).length;
  const pct = list.length ? Math.round(done / list.length * 100) : 0;
  return '<div class="mc" style="--c:' + AREA_COLORS[index % AREA_COLORS.length] + '" title="' +
    esc(a.name + ' · ' + done + '/' + list.length + (list.length ? ' (' + pct + '%)' : '')) + '">' +
    '<div class="h">' + esc(a.name) + '</div>' +
    '<div class="pr"><span class="n">' + done + '/' + list.length + '</span>' +
    '<span class="pct">' + (list.length ? pct + '%' : '—') + '</span></div>' +
    '<div class="pb"><i style="width:' + pct + '%"></i></div></div>';
}

/* ---------- styles & script ---------- */

const CSS = [
':root{',
'  --bg:#0a0e14; --card:#151c26; --card2:#18202b; --line:#232e3b; --line2:#2b3644;',
'  --text:#f2f6fb; --muted:#93a2b6; --dim:#7f8fa3;',
'  --accent:#8fa4ff; --accent2:#b58cff; --good:#4fd8a4; --danger:#ff7d88;',
'  --tile:54px; --cpad:5px; --rpad:6px; --rfont:12.5px; --hfont:9.5px; --sfont:8.5px; --mh:12.5px;',
'}',
'html.dense{--tile:46px;--cpad:4px;--rpad:2px;--rfont:12px;--hfont:9px;--sfont:8px;--mh:11.5px}',
'html.denser{--tile:38px;--cpad:4px;--rpad:1.5px;--rfont:11.5px;--hfont:8.5px;--sfont:7.5px;--mh:11px}',
'html.ultra{--tile:33px;--cpad:3px;--rpad:1px;--rfont:11px;--hfont:8px;--sfont:7px;--mh:10px}',
'/* 화면 높이가 작으면 스크립트가 없어도 먼저 작은 밀도로 그린다 */',
'@media (max-height:230px){html{--tile:46px;--cpad:4px;--rpad:2px;--rfont:12px;--hfont:9px;--sfont:8px;--mh:11.5px}}',
'@media (max-height:200px){html{--tile:38px;--cpad:4px;--rpad:1.5px;--rfont:11.5px;--hfont:8.5px;--sfont:7.5px;--mh:11px}}',
'@media (max-height:175px){html{--tile:33px;--cpad:3px;--rpad:1px;--rfont:11px;--hfont:8px;--sfont:7px;--mh:10px}}',
'*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}',
'html,body{margin:0;padding:0}',
'body{background:radial-gradient(120% 55% at 50% 0%,#17202c 0%,#0a0e14 58%,#080b10 100%);',
'  color:var(--text);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans KR",sans-serif;',
'  min-height:100dvh;font-size:13px;-webkit-text-size-adjust:100%;overflow-x:hidden}',
'.wrap{max-width:520px;margin:0 auto;padding:7px 7px calc(4px + env(safe-area-inset-bottom));',
'  min-height:100dvh;display:flex;flex-direction:column;justify-content:center}',
'[hidden]{display:none!important}',
'.top{display:flex;align-items:baseline;gap:6px;padding:0 1px 4px}',
'.dt{font-size:15px;font-weight:800;letter-spacing:.2px;font-variant-numeric:tabular-nums;line-height:1.1}',
'.dt .wd{font-size:10px;font-weight:700;color:var(--muted);margin-left:2px}',
'.stat{margin-left:auto;font-size:10.5px;color:#b7c4d6;white-space:nowrap;font-variant-numeric:tabular-nums}',
'.stat b{color:#fff;font-size:11.5px;font-weight:800}',
'.stat .dot{color:#55637a;margin:0 3px}',
'.track{height:3px;background:#111823;border:1px solid #1c2531;border-radius:99px;overflow:hidden;margin:0 1px 5px}',
'.track i{display:block;height:100%;width:0;border-radius:99px;',
'  background:linear-gradient(90deg,var(--accent),var(--accent2));transition:width .35s ease}',
'.card{background:linear-gradient(180deg,var(--card),#121821);border:1px solid var(--line);',
'  border-radius:13px;padding:var(--cpad) var(--cpad) calc(var(--cpad) + 1px);',
'  box-shadow:0 6px 16px #00000026;min-width:0}',
'.head{display:flex;align-items:center;gap:5px;margin:0 1px 4px;min-width:0;overflow:hidden}',
'.label{font-size:var(--hfont);font-weight:800;letter-spacing:.1em;color:var(--accent);white-space:nowrap;flex:none}',
'.chip{flex:none;font-size:8px;font-weight:700;color:#cfdaea;background:#1d2733;border:1px solid var(--line2);',
'  border-radius:5px;padding:1px 3px;font-variant-numeric:tabular-nums;white-space:nowrap}',
'.cnt{margin-left:auto;font-size:8.5px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.grid2{display:grid;grid-template-columns:1.45fr 1fr;gap:6px;align-items:start}',
'.col{display:flex;flex-direction:column;gap:5px;min-width:0}',
'.list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}',
'.row{position:relative;display:flex;align-items:center;padding:var(--rpad) 4px var(--rpad) 5px;',
'  border-radius:7px;background:var(--card2);border-left:2px solid #2c3746;min-width:0}',
'.row.u-top{border-left-color:#ff7d88}',
'.row.u-a{border-left-color:#ffc75f}',
'.row.u-b{border-left-color:#59c8f5}',
'.row.u-c{border-left-color:#8fa0b5}',
'.row.done{opacity:.72}',
'.main{min-width:0;flex:1}',
'.title{font-size:var(--rfont);font-weight:700;letter-spacing:-.1px;line-height:1.22;',
'  overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;',
'  word-break:keep-all;overflow-wrap:anywhere}',
'.row.done .title{opacity:.5;text-decoration:line-through}',
'.sub{font-size:var(--sfont);color:#8fa0b5;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
'  font-variant-numeric:tabular-nums;line-height:1.2}',
'.han{display:inline-grid;place-items:center;width:14px;height:14px;border-radius:4px;margin-right:3px;',
'  font-size:9px;font-weight:700;color:#0b0f14;background:var(--c,#8fa4ff);vertical-align:1px;',
'  font-family:"Noto Serif KR","HYhaeseo",serif}',
'.nowline{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--dim);line-height:1.3;',
'  padding:1px 2px;white-space:nowrap;overflow:hidden;font-variant-numeric:tabular-nums}',
'html.dense .nowline,html.denser .nowline{font-size:10px;padding:0 2px}',
'.nowline b{color:#cfdaea;font-weight:800}',
'.nowline .dot{color:#4a5768}',
'html.ultra .row .sub{display:none}',
'.m9{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:3px}',
'.mc{position:relative;border-radius:8px;background:var(--card2);border:1px solid var(--line2);',
'  height:var(--tile);padding:3px 4px 4px;display:flex;flex-direction:column;justify-content:space-between;',
'  overflow:hidden;min-width:0}',
'.mc .h{font-family:"Noto Serif KR","HYhaeseo",serif;font-size:var(--mh);font-weight:700;line-height:1;',
'  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.mc .pr{display:flex;align-items:baseline;gap:2px;margin-top:1px;min-width:0;justify-content:flex-end}',
'.mc .n{font-size:7.5px;color:var(--muted);font-variant-numeric:tabular-nums;line-height:1.1;',
'  white-space:nowrap;overflow:hidden}',
'.mc .pct{font-size:8.5px;font-weight:800;color:var(--c,#8fa4ff);font-variant-numeric:tabular-nums;',
'  line-height:1.1;margin-left:auto}',
'.mc .pb{height:2px;border-radius:99px;background:#0c1218;margin-top:2px;overflow:hidden;flex:none}',
'.mc .pb i{display:block;height:100%;width:0;background:var(--c,#8fa4ff)}',
'html.dense .mc .pct{font-size:8px}',
'html.denser .mc .pct{font-size:7.5px}',
'html.dense .mc .n{font-size:7px}',
'html.denser .mc .n{font-size:6.5px}',
'.mc.core{background:linear-gradient(150deg,#2b2452,#1a2233 70%);border-color:#3c3a6e;',
'  flex-direction:column;align-items:center;justify-content:center;gap:1px;padding:2px}',
'.core .cb{display:grid;grid-template-columns:auto auto;column-gap:1px;line-height:1;font-weight:700;',
'  font-family:"Noto Serif KR","HYhaeseo",serif;font-size:10px;color:#e9e4ff;text-align:center}',
'.core .pct2{font-size:11px;font-weight:900;color:#fff;line-height:1;font-variant-numeric:tabular-nums}',
'html.dense .core .cb{font-size:9px}',
'html.dense .core .pct2{font-size:10px}',
'html.denser .core .cb{font-size:8px}',
'html.denser .core .pct2{font-size:9px}',
'html.dense .dt{font-size:14px}',
'html.denser .dt{font-size:13px}',
'html.denser .top{padding-bottom:4px}',
'html.denser .track{margin-bottom:5px}',
'html.denser .head{margin-bottom:3px}',
'html.denser .stat{font-size:9px}',
'html.denser .stat b{font-size:10px}',
'html.ultra .top{padding-bottom:3px}',
'html.ultra .track{margin-bottom:4px}',
'html.ultra .dt{font-size:12px}',
'html.ultra .stat{font-size:8.5px}',
'html.ultra .stat b{font-size:9.5px}',
'html.ultra .head{margin-bottom:2px}',
'html.ultra .chip{display:none}',
'html.ultra .mc{padding:2px 3px}',
'html.ultra .mc .h{font-size:10px}',
'html.ultra .mc .pct{font-size:7px}',
'html.ultra .mc .n{font-size:6px}',
'html.ultra .nowline{font-size:8.5px;padding:0 1px}',
'html.ultra .core .cb{font-size:7.5px}',
'html.ultra .core .pct2{font-size:8.5px}',
'body.err{display:grid;place-items:center;min-height:100dvh;padding:14px}',
'.errbox{max-width:420px;width:100%;background:linear-gradient(180deg,var(--card),#121821);',
'  border:1px solid #5a2230;border-radius:13px;padding:12px 13px}',
'.errbox .t{font-size:10px;letter-spacing:.16em;font-weight:800;color:var(--danger)}',
'.errbox .m{margin-top:6px;font-size:12.5px;line-height:1.5;color:#e8eef7;word-break:break-word}',
'.errbox .m b{color:#fff}',
'.errbox button{margin-top:10px;border:0;border-radius:9px;padding:7px 13px;font-size:12px;font-weight:800;',
'  color:#0a0e16;background:linear-gradient(90deg,var(--accent),var(--accent2))}'
].join('\n');

const FIT_SCRIPT = [
'(function(){',
'  "use strict";',
'  var app=document.getElementById("appView");',
'  if(!app) return;',
'  var html=document.documentElement;',
'  var rows=[].slice.call(document.querySelectorAll("#nowList > li"));',
'  function over(){var r=app.getBoundingClientRect();return r.bottom>window.innerHeight+0.5||r.top<-0.5;}',
'  function fit(){',
'    html.classList.remove("dense","denser","ultra");',
'    for(var i=0;i<rows.length;i++) rows[i].hidden=false;',
'    if(over()) html.classList.add("dense");',
'    if(over()) html.classList.add("denser");',
'    for(var j=rows.length-1;j>=1&&over();j--) rows[j].hidden=true;',
'    if(over()) html.classList.add("ultra");',
'    if(window.scrollY) window.scrollTo(0,0);',
'  }',
'  window.addEventListener("resize",fit);',
'  window.addEventListener("orientationchange",fit);',
'  setTimeout(fit,0); setTimeout(fit,90); setTimeout(fit,450); setTimeout(fit,900);',
'  if(document.fonts&&document.fonts.ready){document.fonts.ready.then(fit)["catch"](function(){});}',
'  /* 읽기 전용: 새로고침 버튼 없음 */',
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
  const mandala = renderMandala(c);

  return head('MANDALA · 지금') +
    '<body>\n<main class="wrap" id="appView">\n' +
    '  <header class="top">\n' +
    '    <div class="dt"><span id="kDate">' + top.date + '</span><span class="wd" id="kDow">' + top.dow + '</span></div>\n' +
    '    <div class="stat" id="kStat">' + top.stat + '</div>\n' +
    '  </header>\n' +
    '  <div class="track"><i id="overallBar" style="width:' + top.barWidth + '%"></i></div>\n\n' +
    '  <div class="grid2">\n' +
    '    <div class="col">\n' +
    '      <section class="card">\n' +
    '        <div class="head">\n' +
    '          <span class="label" id="nowLabel">' + esc(now.label) + '</span>\n' +
    '          <span class="chip" id="nowSlotTag"' + (now.hiddenChip ? ' hidden' : '') + '>' + esc(now.chip) + '</span>\n' +
    '          <span class="cnt" id="nowCnt">' + esc(now.cnt) + '</span>\n' +
    '        </div>\n' +
    '        <ul class="list" id="nowList"' + (now.hiddenList ? ' hidden' : '') + '>' + now.rows.join('') + '</ul>\n' +
    '        <div class="nowline" id="nowEmpty"' + (now.hiddenEmpty ? ' hidden' : '') + '>' + now.empty + '</div>\n' +
    '      </section>\n\n' +
    '      <section class="card">\n' +
    '        <div class="head">\n' +
    '          <span class="label">TOP TO-DO</span>\n' +
    '          <span class="cnt" id="todoCnt">' + esc(todos.cnt) + '</span>\n' +
    '        </div>\n' +
    '        <ul class="list" id="todoList"' + (todos.hiddenList ? ' hidden' : '') + '>' + todos.rows.join('') + '</ul>\n' +
    '        <div class="nowline" id="todoEmpty"' + (todos.hiddenEmpty ? ' hidden' : '') + '>오늘 남은 To-do 없음</div>\n' +
    '      </section>\n' +
    '    </div>\n\n' +
    '    <section class="card">\n' +
    '      <div class="head">\n' +
    '        <span class="label">만다라트</span>\n' +
    '        <span class="cnt" id="mOverall">' + esc(mandala.cnt) + '</span>\n' +
    '      </div>\n' +
    '      <div class="m9" id="m9">' + mandala.cells + '</div>\n' +
    '    </section>\n' +
    '  </div>\n\n' +
    '</main>\n' +
    '<script>\n' + FIT_SCRIPT + '\n</script>\n' +
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
