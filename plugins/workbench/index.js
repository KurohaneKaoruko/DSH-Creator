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
//   POST /creator-workbench/v1/api/save         保存一个 .md 并返回正文检查结果
//   POST /creator-workbench/v1/api/lint         只检查，不落盘
//   POST /creator-workbench/v1/api/stats        工程总览（章节/字数/伏笔/目录）
//   POST /creator-workbench/v1/api/scaffold     初始化作品工程骨架
//   POST /creator-workbench/v1/api/new-chapter  新建下一章（撞号拒收）
//   POST /creator-workbench/v1/api/index        重建 README / 人物卡 / 设定集索引
//   GET  /creator-workbench/v1/api/health       诊断（是否挂到 Web 宿主）
//
// 宿主可能没有 webServer（ACP、桌面 IPC 等），因此本插件不声明强制注入：
// 服务出现时再注册路由，缺失时保持静默，不影响任何助手预设的挂载。

import path from 'node:path';

import { lintText } from '../lint.mjs';
import {
  PROJECT,
  chapterFile,
  countChars,
  openProject,
  padChapter,
  parseChapterFile,
  projectStats,
  rebuildIndex,
  scaffold,
  safeName,
  saveChapter,
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

/** 归一化工作区相对路径：拒绝绝对路径、盘符与越界段 */
function normalizeRel(input) {
  if (typeof input !== 'string' || !input.trim()) throw new ApiError(400, 'bad-path', '缺少文件路径');
  if (input.includes('\0')) throw new ApiError(400, 'bad-path', '路径包含非法字符');
  const raw = input.replace(/\\/g, '/');
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) throw new ApiError(400, 'bad-path', '只接受工作区相对路径');
  const clean = path.posix.normalize(raw).replace(/^\.\//, '');
  if (clean === '.' || clean.startsWith('../') || clean === '..') throw new ApiError(400, 'bad-path', '路径越出工作区');
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
      await project.write(rel, body.content);
      return ok(res, { path: rel, chars: countChars(body.content), lint: packLint(lintText(body.content)) });
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
      const created = await scaffold(project, title || '未命名作品');
      return ok(res, { created, stats: await projectStats(project) });
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

    default:
      throw new ApiError(404, 'not-found', `未知接口：${action}`);
  }
}

export { API_PREFIX, normalizeRel, resolveInside, chapterFile, parseChapterFile, PROJECT };
