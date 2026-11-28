'use strict';

/**
 * POST /api/widget/toggle?key=<WIDGET_KEY>   (vercel.json rewrite → /api/widget-toggle)
 *
 * 위젯에서 과업/To-do 를 탭했을 때 완료 체크/해제를 저장한다.
 *
 * body (JSON):
 *   { type: 'task', taskId: '<uuid>', completed: true|false }
 *   { type: 'todo', id: '<uuid>', completed: true|false, prevStatus?: 'in_progress' }
 *
 * 스키마는 index.html 과 동일하게 맞춘다.
 *   - task_records : insert { user_id, task_id, completed_date(오늘, Asia/Seoul), xp_earned }
 *                    해제는 오늘 날짜 행 delete (index.html toggleTask 와 같은 방식)
 *   - daily_todos  : status 를 'completed' / 이전 상태로 update (+ updated_at, 완료 시 todo_date=오늘)
 *                    (daily_todos 에는 completed / completed_at 컬럼이 없고 status 를 쓴다)
 *
 * 응답: { ok:true, type, id, completed, xpDelta, status? }
 *       실패: { ok:false, error, message }
 */

const { getConfig, checkKey, kstToday, sbSend } = require('../lib/widget-data');

const OPEN_STATUSES = ['pending', 'in_progress'];
const MAX_BODY = 8 * 1024;

function fail(res, status, code, message) {
  res.status(status).json({ ok: false, error: code, message: message || '' });
}

function readBody(req) {
  // Vercel Node 런타임은 보통 req.body 를 파싱해 준다. 문자열/버퍼면 직접 파싱한다.
  const b = req && req.body;
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return b;
  let raw = '';
  if (typeof b === 'string') raw = b;
  else if (Buffer.isBuffer(b)) raw = b.toString('utf8');
  if (!raw) return null;
  if (raw.length > MAX_BODY) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function uuidLike(v) {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(String(v || ''));
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const method = String((req && req.method) || 'GET').toUpperCase();
  if (method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(res, 405, 'METHOD_NOT_ALLOWED', 'POST only');
  }

  const cfg = getConfig();
  if (!cfg.widgetKey || !cfg.serviceKey) {
    return fail(res, 500, 'WIDGET_KEY_NOT_CONFIGURED', 'widget environment variables are not set');
  }

  const verdict = checkKey(req);
  if (verdict === 'missing_config') return fail(res, 500, 'WIDGET_KEY_NOT_CONFIGURED', 'widget environment variables are not set');
  if (verdict === 'invalid') return fail(res, 401, 'INVALID_KEY', 'invalid widget key');

  const body = readBody(req);
  if (!body) return fail(res, 400, 'BAD_BODY', 'JSON body required');

  const type = String(body.type || '');
  const completed = body.completed === true || body.completed === 'true';
  const uid = encodeURIComponent(cfg.userId);
  const today = kstToday();

  try {
    if (type === 'task') {
      const taskId = String(body.taskId || '');
      if (!uuidLike(taskId)) return fail(res, 400, 'BAD_ID', 'taskId must be a uuid');

      const tasks = await sbSend(cfg, 'tasks?select=id,name,xp,active&user_id=eq.' + uid + '&id=eq.' + encodeURIComponent(taskId) + '&limit=1', 'GET');
      const task = Array.isArray(tasks) ? tasks[0] : null;
      if (!task) return fail(res, 404, 'TASK_NOT_FOUND', 'task not found');

      const xp = Math.round(Number(task.xp) || 0);
      const recPath = 'task_records?select=id,xp_earned&user_id=eq.' + uid +
        '&task_id=eq.' + encodeURIComponent(taskId) + '&completed_date=eq.' + today + '&limit=5';
      const existing = await sbSend(cfg, recPath, 'GET');
      const has = Array.isArray(existing) && existing.length > 0;

      if (completed && !has) {
        await sbSend(cfg, 'task_records', 'POST', {
          user_id: cfg.userId,
          task_id: taskId,
          completed_date: today,
          xp_earned: xp
        }, 'return=minimal');
        return res.status(200).json({ ok: true, type: 'task', id: taskId, completed: true, xpDelta: xp });
      }

      if (!completed && has) {
        await sbSend(cfg, 'task_records?user_id=eq.' + uid + '&task_id=eq.' + encodeURIComponent(taskId) +
          '&completed_date=eq.' + today, 'DELETE', undefined, 'return=minimal');
        return res.status(200).json({ ok: true, type: 'task', id: taskId, completed: false, xpDelta: -xp });
      }

      // 이미 원하는 상태: 아무것도 바꾸지 않는다.
      return res.status(200).json({ ok: true, type: 'task', id: taskId, completed: has, xpDelta: 0, unchanged: true });
    }

    if (type === 'todo') {
      const id = String(body.id || '');
      if (!uuidLike(id)) return fail(res, 400, 'BAD_ID', 'id must be a uuid');

      const rows = await sbSend(cfg, 'daily_todos?select=id,status,xp,todo_date,active&user_id=eq.' + uid +
        '&id=eq.' + encodeURIComponent(id) + '&limit=1', 'GET');
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) return fail(res, 404, 'TODO_NOT_FOUND', 'todo not found');

      const xp = Math.round(Number(row.xp) || 0);
      const wasDone = (row.status || '') === 'completed';

      if (completed === wasDone) {
        return res.status(200).json({ ok: true, type: 'todo', id: id, completed: wasDone, xpDelta: 0, unchanged: true, status: row.status || null });
      }

      let target = 'completed';
      if (!completed) {
        const prev = String(body.prevStatus || '');
        target = OPEN_STATUSES.includes(prev) ? prev : 'pending';
      }

      const patch = { status: target, updated_at: new Date().toISOString() };
      if (completed) patch.todo_date = today;   // index.html 과 동일: 완료 시 오늘 업무로 편입

      await sbSend(cfg, 'daily_todos?user_id=eq.' + uid + '&id=eq.' + encodeURIComponent(id), 'PATCH', patch, 'return=minimal');

      return res.status(200).json({
        ok: true, type: 'todo', id: id, completed: completed, xpDelta: completed ? xp : -xp, status: target
      });
    }

    return fail(res, 400, 'BAD_TYPE', "type must be 'task' or 'todo'");
  } catch (e) {
    console.error('[api/widget-toggle] failed:', (e && e.message) || e);
    return fail(res, 502, 'SUPABASE_ERROR', 'failed to write to Supabase');
  }
};
