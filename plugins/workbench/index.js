// 创作工作台 · Host 侧
// -----------------------------------------------------------------------------
// 一个作品工程的 Web 侧网关：读取走官方 workspaceFiles Remote（Client 侧），
// 写入与工程操作走这里。所有写操作都锚定到「当前会话的工作区」：
//   1. 客户端只传 sessionId 与工作区相对路径，Host 用 SessionStore 取 header.cwd；
//   2. 解析后的绝对路径必须落在 cwd 内（拒绝 ../、绝对路径、盘符路径）；
//   3. 只允许写 .md，单次请求上限 8 MiB；
//   4. 写入经 ctx.fs + sandboxPolicy，与 Agent 的 write 工具同一通道。
//
// 路由：
//   POST /creator-workbench/v1/api/save         保存一个 .md 并返回正文检查结果（带内容指纹与版本冲突保护）
//   POST /creator-workbench/v1/api/lint         只检查，不落盘
//   POST /creator-workbench/v1/api/stats        工程总览（章节/字数/伏笔/目录）
//   POST /creator-workbench/v1/api/scaffold     初始化作品工程骨架
//   POST /creator-workbench/v1/api/new-chapter  新建下一章（撞号拒收）
//   POST /creator-workbench/v1/api/search       全文检索（正文/大纲/设定集/人物卡/归档/追踪）
//   POST /creator-workbench/v1/api/history      列出手工保存产生的历史快照
//   POST /creator-workbench/v1/api/diff         历史快照对比（行级 diff，长章节降级为仅统计）
//   POST /creator-workbench/v1/api/restore      恢复某个历史快照（恢复前先把当前内容存快照）
//   POST /creator-workbench/v1/api/index        重建 README / 人物卡 / 设定集索引
//   POST /creator-workbench/v1/api/scan         全书体检（游标分批：offset/batch，返回 next 游标）
//   POST /creator-workbench/v1/api/activity     写作活动统计（只读：快照+mtime 推最近 14 天）
//   POST /creator-workbench/v1/api/goal         写作目标写入（README 元信息行：目标字数/目标完稿）
//   GET  /creator-workbench/v1/api/health       诊断（是否挂到 Web 宿主）
//
// 宿主可能没有 webServer（ACP、桌面 IPC 等），因此本插件不声明强制注入：
// 服务出现时再注册路由，缺失时保持静默，不影响任何助手预设的挂载。

import path from 'node:path';

import { lintText } from '../lint.mjs';
import {
  PROJECT,
  SNAPSHOT_NAME_RE,
  activityReport,
  chapterFile,
  countChars,
  diffLines,
  hashText,
  historyFolder,
  openProject,
  padChapter,
  parseChapterFile,
  parseGoal,
  projectStats,
  readmeMeta,
  rebuildIndex,
  scaffold,
  scanBook,
  safeName,
  saveChapter,
  searchProject,
  writeGoal,
} from '../project-core.mjs';

export const name = 'creator-workbench';
export const inject = [];

const API_PREFIX = '/creator-workbench/v1/api';
const MAX_BODY = 8 * 1024 * 1024;

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function ok(res, data) {
  sendJson(res, 200, { ok: true, data });
}

function fail(res, err) {
  const status = err instanceof ApiError ? err.status : 500;
  const code = err instanceof ApiError ? err.code : 'server-error';
  sendJson(res, status, { ok: false, error: { code, message: String((err && err.message) || err) } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new ApiError(413, 'payload-too-large', '请求体超过 8 MiB 上限'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try { resolve(JSON.parse(text)); } catch (err) { reject(new ApiError(400, 'bad-json', '请求体不是合法 JSON')); }
      return undefined;
    });
    req.on('error', reject);
  });
}

/** 归一化工作区相对路径：拒绝绝对路径、盘符、越界段与点开头的隐藏段 */
function normalizeRel(input) {
  if (typeof input !== 'string' || !input.trim()) throw new ApiError(400, 'bad-path', '缺少文件路径');
  if (input.includes('\0')) throw new ApiError(400, 'bad-path', '路径包含非法字符');
  const raw = input.replace(/\\/g, '/');
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) throw new ApiError(400, 'bad-path', '只接受工作区相对路径');
  const clean = path.posix.normalize(raw).replace(/^\.\//, '');
  if (clean === '.' || clean.startsWith('../') || clean === '..') throw new ApiError(400, 'bad-path', '路径越出工作区');
  // 点开头的路径段是保留区（.history/ 等）：工作台不得把普通文件写进去，
  // 否则快照目录会被当文件污染，历史列表也会扫到伪快照。
  if (clean.split('/').some((seg) => seg.startsWith('.'))) throw new ApiError(400, 'bad-path', '不允许写入点开头的隐藏路径');
  return clean;
}

/** 绝对路径必须落在会话工作区内 */
function resolveInside(cwd, rel) {
  const root = path.resolve(cwd);
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) throw new ApiError(403, 'forbidden', '路径越出工作区');
  return target;
}

function packLint(result) {
  return {
    hardCount: result.hardCount,
    softCount: result.softCount,
    report: result.report,
    issues: result.issues.map(([level, name, detail]) => ({ level, name, detail })),
  };
}

/**
 * 安装工作台（Host 侧）。webServer 出现时注册路由；返回清理函数。
 * @param {any} ctx cordis 上下文
 */
export function apply(ctx) {
  let disposeRoutes;
  let installed = false;

  const install = (webServer) => {
    if (installed || !webServer || typeof webServer.register !== 'function') return;
    disposeRoutes = webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        try {
          const raw = String(req.url || '/');
          const sub = raw.startsWith(API_PREFIX) ? raw.slice(API_PREFIX.length) : raw;
          const action = sub.split('?')[0].replace(/^\//, '');
          if (req.method === 'GET' && action === 'health') {
            return ok(res, { plugin: 'creator-workbench', prefix: API_PREFIX });
          }
          if (req.method !== 'POST') throw new ApiError(405, 'method-not-allowed', '只支持 POST');
          const body = await readBody(req);
          return await handle(ctx, action, body, res);
        } catch (err) {
          return fail(res, err);
        }
      },
    });
    installed = true;
  };

  const current = ctx.get('webServer');
  if (current) install(current);
  const off = ctx.on('internal/service', (serviceName, service) => {
    if (serviceName === 'webServer') install(service);
  });

  return () => {
    if (typeof off === 'function') off();
    if (typeof disposeRoutes === 'function') disposeRoutes();
  };
}

async function handle(ctx, action, body, res) {
  const fs = ctx.get('fs');
  const sessions = ctx.get('sessions');
  const sandboxPolicy = ctx.get('sandboxPolicy');
  if (!fs) throw new ApiError(503, 'fs-unavailable', '文件系统服务不可用');

  const sessionOf = (sessionId) => {
    if (!sessionId || typeof sessionId !== 'string') throw new ApiError(400, 'no-session', '缺少会话标识');
    if (!sessions || typeof sessions.get !== 'function') throw new ApiError(503, 'sessions-unavailable', '会话服务不可用');
    const session = sessions.get(sessionId);
    if (!session) throw new ApiError(404, 'no-session', '会话不存在或已关闭');
    const cwd = session.header && session.header.cwd;
    if (!cwd) throw new ApiError(400, 'no-workspace', '该会话没有工作区目录');
    const policy = (() => {
      try { return sandboxPolicy ? sandboxPolicy.resolve({ session }) : undefined; } catch (err) { return undefined; }
    })();
    return { session, cwd, policy };
  };

  const io = (cwd, policy) => openProject(fs, cwd, policy);

  switch (action) {
    case 'lint': {
      const text = typeof body.text === 'string' ? body.text : '';
      if (!text.trim()) throw new ApiError(400, 'bad-request', '缺少待检查正文');
      return ok(res, packLint(lintText(text)));
    }

    case 'save': {
      const { cwd, policy } = sessionOf(body.sessionId);
      const rel = normalizeRel(body.path);
      if (!/\.md$/i.test(rel)) throw new ApiError(400, 'bad-file', '只允许保存 .md 文件');
      if (typeof body.content !== 'string') throw new ApiError(400, 'bad-request', '缺少 content');
      resolveInside(cwd, rel);
      const project = io(cwd, policy);
      const target = await fs.resolve(rel, { cwd });
      const hasStat = typeof fs.stat === 'function';
      const beforeInfo = hasStat ? await fs.stat(target) : undefined;
      if (beforeInfo && beforeInfo.type !== 'file') {
        throw new ApiError(400, 'bad-file', '目标路径不是普通文件，拒绝写入');
      }
      let beforeText = '';
      if (beforeInfo) {
        try { beforeText = await fs.readText(target); } catch (err) { beforeText = ''; }
      }
      if (typeof body.baseHash === 'string' && hashText(beforeText) !== body.baseHash) {
        throw new ApiError(409, 'conflict', `文件已被外部修改（当前 ${countChars(beforeText)} 字），请重新加载后再保存`);
      }
      let snapshotInfo = null;
      let historyWarning = '';
      if (body.history === true && beforeInfo && beforeText && body.content !== beforeText) {
        try {
          snapshotInfo = await project.snapshot(rel, beforeText);
        } catch (err) {
          // 快照失败不阻断保存；把原因回传，避免静默丢历史
          historyWarning = String((err && err.message) || err);
        }
      }
      const expected = body.force === true || !hasStat
        ? undefined
        : beforeInfo
          ? { kind: 'replaceIfVersion', version: beforeInfo.version }
          : { kind: 'createIfAbsent' };
      let outcome;
      try {
        outcome = await project.writeGuarded(rel, body.content, expected);
      } catch (err) {
        if (err && (err.code === 'FS_STALE_VERSION' || err.code === 'FS_NOT_OBSERVED')) {
          throw new ApiError(409, 'conflict', '文件在保存瞬间被其他操作修改，请重新加载后再保存');
        }
        throw err;
      }
      return ok(res, {
        path: rel,
        chars: countChars(body.content),
        hash: hashText(body.content),
        operation: outcome && outcome.operation,
        snapshot: snapshotInfo ? { ...snapshotInfo } : null,
        historyWarning: historyWarning || null,
        lint: packLint(lintText(body.content)),
      });
    }

    case 'stats': {
      const { cwd, policy } = sessionOf(body.sessionId);
      const project = io(cwd, policy);
      return ok(res, await projectStats(project));
    }

    case 'scaffold': {
      const { cwd, policy } = sessionOf(body.sessionId);
      const title = typeof body.title === 'string' ? safeName(body.title) : '';
      const project = io(cwd, policy);
      const before = await projectStats(project);
      if (before.initialized && body.force !== true) {
        throw new ApiError(409, 'already-initialized', '当前工作区已有作品工程；为避免覆盖正文与设定，未重复初始化。确需重建请传 force=true');
      }
      const created = await scaffold(project, title || '未命名作品');
      return ok(res, { created, stats: await projectStats(project) });
    }

    case 'search': {
      const { cwd, policy } = sessionOf(body.sessionId);
      const project = io(cwd, policy);
      const query = typeof body.query === 'string' ? body.query.trim().slice(0, 120) : '';
      return ok(res, await searchProject(project, query, { limit: body.limit }));
    }

    case 'history': {
      const { cwd, policy } = sessionOf(body.sessionId);
      const rel = normalizeRel(body.path);
      if (!/\.md$/i.test(rel)) throw new ApiError(400, 'bad-file', '只允许查看 .md 的历史');
      resolveInside(cwd, rel);
      resolveInside(cwd, historyFolder(rel));
      const project = io(cwd, policy);
      const snapshots = await project.snapshots(rel);
      return ok(res, { path: rel, snapshots: snapshots.slice(0, 30) });
    }

    // 历史快照对比：恢复前先看清「快照与当前差在哪」。行级 diff 在内核
    // diffLines（自写 LCS）；长章节超过行数上限自动降级为仅统计（rows=null）。
    case 'diff': {
      const { cwd, policy } = sessionOf(body.sessionId);
      const rel = normalizeRel(body.path);
      if (!/\.md$/i.test(rel)) throw new ApiError(400, 'bad-file', '只允许对比 .md 的历史');
      const name = String(body.snapshot || '');
      if (!SNAPSHOT_NAME_RE.test(name)) throw new ApiError(400, 'bad-snapshot', '历史快照名不合法');
      resolveInside(cwd, rel);
      resolveInside(cwd, `${historyFolder(rel)}/${name}`);
      const project = io(cwd, policy);
      const snapshotText = await project.readSnapshot(rel, name).catch((err) => {
        if (err && err.code === 'FS_NOT_FOUND') throw new ApiError(404, 'history-not-found', '历史快照不存在或已被清理');
        throw err;
      });
      const currentText = await project.readMaybe(rel);
      return ok(res, {
        path: rel,
        snapshot: name,
        exists: currentText !== null,
        ...diffLines(snapshotText, currentText || ''),
      });
    }

    case 'restore': {
      const { cwd, policy } = sessionOf(body.sessionId);
      const rel = normalizeRel(body.path);
      if (!/\.md$/i.test(rel)) throw new ApiError(400, 'bad-file', '只允许恢复 .md 文件');
      const name = String(body.snapshot || '');
      if (!SNAPSHOT_NAME_RE.test(name)) throw new ApiError(400, 'bad-snapshot', '历史快照名不合法');
      resolveInside(cwd, rel);
      resolveInside(cwd, `${historyFolder(rel)}/${name}`);
      const project = io(cwd, policy);
      const target = await fs.resolve(rel, { cwd });
      const hasStat = typeof fs.stat === 'function';
      const beforeInfo = hasStat ? await fs.stat(target) : undefined;
      if (beforeInfo && beforeInfo.type !== 'file') {
        throw new ApiError(400, 'bad-file', '目标路径不是普通文件，拒绝恢复到目录');
      }
      let beforeText = '';
      if (beforeInfo && beforeInfo.type === 'file') {
        try { beforeText = await fs.readText(target); } catch (err) { beforeText = ''; }
      }
      let restoredText;
      try {
        restoredText = await project.readSnapshot(rel, name);
      } catch (err) {
        if (err && err.code === 'FS_NOT_FOUND') throw new ApiError(404, 'history-not-found', '历史快照不存在或已被清理');
        throw err;
      }
      let snapshotInfo = null;
      if (beforeInfo && beforeText && beforeText !== restoredText) {
        try { snapshotInfo = await project.snapshot(rel, beforeText); } catch (err) { /* 恢复优先 */ }
      }
      const expected = !hasStat || body.force === true
        ? undefined
        : beforeInfo
          ? { kind: 'replaceIfVersion', version: beforeInfo.version }
          : { kind: 'createIfAbsent' };
      let outcome;
      try {
        outcome = await project.writeGuarded(rel, restoredText, expected);
      } catch (err) {
        if (err && (err.code === 'FS_STALE_VERSION' || err.code === 'FS_NOT_OBSERVED')) {
          throw new ApiError(409, 'conflict', '恢复瞬间文件被其他操作修改，请重新加载后再试');
        }
        throw err;
      }
      return ok(res, {
        path: rel,
        text: restoredText,
        chars: countChars(restoredText),
        hash: hashText(restoredText),
        operation: outcome && outcome.operation,
        restored: name,
        snapshot: snapshotInfo ? { ...snapshotInfo } : null,
      });
    }

    case 'new-chapter': {
      const { cwd, policy } = sessionOf(body.sessionId);
      const project = io(cwd, policy);
      const existing = await project.chapters();
      const lastNum = existing.length ? existing[existing.length - 1].num : 0;
      const num = body.number === undefined || body.number === null || body.number === ''
        ? lastNum + 1
        : Number(body.number);
      if (!Number.isInteger(num) || num < 1) throw new ApiError(400, 'bad-number', '章节序号必须是正整数');
      if (existing.some((c) => c.num === num)) throw new ApiError(409, 'conflict', `第${padChapter(num)}章已存在，请换一个章号`);
      const title = typeof body.title === 'string' ? safeName(body.title) : '';
      const file = await saveChapter(project, num, title, '');
      return ok(res, { path: file, number: num, title });
    }

    case 'index': {
      const { cwd, policy } = sessionOf(body.sessionId);
      const project = io(cwd, policy);
      const stats = await projectStats(project);
      const title = (typeof body.title === 'string' && body.title.trim()) || stats.title || '未命名作品';
      const summary = await rebuildIndex(project, title);
      return ok(res, { summary, stats: await projectStats(project) });
    }

    // 全书体检：游标式分批，前端带着上一次返回的 next 循环调用。
    // 每批只读 batch 章正文，几百章的工程也不会把内存和 UI 卡死。
    case 'scan': {
      const { cwd, policy } = sessionOf(body.sessionId);
      const project = io(cwd, policy);
      const data = await scanBook(project, {
        offset: body.offset,
        batch: body.batch,
      });
      return ok(res, data);
    }

    // 纯文本导出的服务端转换：前端拼好全本 Markdown 后发回来转 TXT。
    // 只做格式转换，不落盘——文件仍由浏览器直接下载。
    case 'export-plain': {
      if (typeof body.content !== 'string') throw new ApiError(400, 'bad-request', '缺少待转换内容');
      if (body.content.length > 4 * 1024 * 1024) throw new ApiError(413, 'payload-too-large', '全本内容超过 4 MiB，无法转换');
      return ok(res, { text: toPlainText(body.content) });
    }

    // 写作活动统计（只读）：历史快照 + 章节文件修改时间 → 最近 14 天的
    // 保存次数、新增字数与连续写作天数。无数据时前端渲染空态。
    case 'activity': {
      const { cwd, policy } = sessionOf(body.sessionId);
      const project = io(cwd, policy);
      const data = await activityReport(project, fs, cwd, { days: body.days });
      return ok(res, data);
    }

    // 写作目标：读走 stats（projectStats 已带 goal），这里只负责写入。
    // 目标存 README 元信息行（与简介/状态同一套约定），不新增文件、
    // 不破坏目录结构；写入前做版本守卫，README 刚被改动时拒绝静默覆盖。
    // 字段语义与 writeGoal 对齐：字段缺失 → 该行不动（保留旧值）；显式 null
    // → 删除该行（清除）。这样「只改日期」不会误删字数行，「全 null」才是清除。
    case 'goal': {
      const { cwd, policy } = sessionOf(body.sessionId);
      const project = io(cwd, policy);
      const current = await project.readMaybe(PROJECT.readme, 100000);
      if (current === null) throw new ApiError(404, 'no-readme', '还没有 README.md；先初始化作品工程');
      const hasChars = Object.prototype.hasOwnProperty.call(body, 'chars');
      const hasDate = Object.prototype.hasOwnProperty.call(body, 'date');
      const chars = !hasChars || body.chars === undefined || body.chars === ''
        ? undefined
        : body.chars === null ? null : Number(body.chars);
      if (chars !== undefined && chars !== null && (!Number.isFinite(chars) || chars <= 0 || chars > 100000000)) {
        throw new ApiError(400, 'bad-goal', '目标字数必须是正整数（单位：字）');
      }
      const date = !hasDate || body.date === undefined || body.date === ''
        ? undefined
        : body.date === null ? null : String(body.date);
      if (date !== undefined && date !== null && !/^\d{4}-\d{1,2}-\d{1,2}$/.test(date)) {
        throw new ApiError(400, 'bad-goal', '目标完稿日期格式应为 YYYY-MM-DD');
      }
      if (chars === undefined && date === undefined) {
        throw new ApiError(400, 'bad-goal', '至少提供 chars 或 date；要清除目标请显式传 null');
      }
      const next = writeGoal(current, { chars, date });
      const target = await fs.resolve(PROJECT.readme, { cwd });
      const info = typeof fs.stat === 'function' ? await fs.stat(target) : undefined;
      const expected = !info || typeof fs.writeText !== 'function' || fs.writeText.length >= 5
        ? undefined
        : { kind: 'replaceIfVersion', version: info.version };
      try {
        await project.writeGuarded(PROJECT.readme, next, expected);
      } catch (err) {
        if (err && (err.code === 'FS_STALE_VERSION' || err.code === 'FS_NOT_OBSERVED')) {
          throw new ApiError(409, 'conflict', 'README 刚被其他操作修改，请刷新工程后重试');
        }
        throw err;
      }
      return ok(res, { goal: parseGoal(readmeMeta(next)) });
    }

    default:
      throw new ApiError(404, 'not-found', `未知接口：${action}`);
  }
}

export { API_PREFIX, normalizeRel, resolveInside, chapterFile, parseChapterFile, PROJECT };
