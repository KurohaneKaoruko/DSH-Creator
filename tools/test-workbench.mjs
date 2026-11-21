#!/usr/bin/env node
// 创作工作台测试（不依赖 dsh 内核）
// -----------------------------------------------------------------------------
// 工作台是产品主体：Host 路由必须能在「只有 fs + sessions 的宿主」里安全地
// 读写会话工作区，并且拒绝越界路径、非 .md、未知会话。这里用 node:fs 实现最小
// 的 fs / sessions / sandboxPolicy / webServer 替身，直接调用 apply(ctx)，把
// 注册出来的 prefix 路由当成 HTTP handler 跑。
//
// 覆盖：
//   1. webServer 已存在 / 后出现（internal/service）都能注册路由；
//   2. 空工作区 → scaffold → 新建章节 → 保存 → stats → index 的完整工作流；
//   3. 保存带硬违规仍落盘，但返回检查结果（工作台是人工编辑，不做门禁拦截）；
//   4. ../ 越界、绝对路径、非 .md、未知会话全部拒绝且不落盘；
//   5. 撞号新建章节返回 409；
//   6. 保存内容指纹冲突 409、force 覆盖、全文检索、重复 scaffold 409、README 简介/状态保留；
//   7. 手工保存历史快照、历史列表倒序、恢复回滚与恢复前留快照；
//   8. 包结构：工作台已并入主包（无独立 plugins-dsh 编辑器）、exports/dsh.client 完整；
//   9. Client 源码语法可解析；工作台作为 main 面板注册并出现在左侧工作区列表上方。
//
// 跑法：node test-workbench.mjs

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access, stat as fsStat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import url from 'node:url';

import { apply, API_PREFIX } from '../plugins/workbench/index.js';
import { inspectBundleContract, REQUIRED_CLIENT_DEPENDENCIES } from './bundle-contract.mjs';
import { checkCompatibility, compareVersions, MIN_SUPPORTED_DSH } from './compatibility.mjs';
import { parseChapterFile, chapterFile, countChars, auditForeshadow, hashText, searchProject, readmeMeta, historyFolder, snapshotName, SNAPSHOT_NAME_RE, PROJECT, scanBook, toPlainText, activityReport, openProject, parseGoal, writeGoal, diffLines, findBacklinkHits, scanBacklinks } from '../plugins/project-core.mjs';
const repoRoot = path.resolve(url.fileURLToPath(new URL('..', import.meta.url)));

// Client.js 里的纯函数源码提取器：Client 侧 resolveWikiLink / wikiSkeleton 与
// 其他前端函数一起住在 client.js 的 factory 闭包里，无法直接 import；这里用与
// hashText/toPlainText 一致性测试相同的办法，把函数源码抠出来在 Node 里跑。
async function clientFunction(name) {
  const source = await readFile(path.join(repoRoot, 'plugins', 'workbench', 'client.js'), 'utf8');
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `Client 缺少 ${name} 实现`);
  let depth = 0;
  let i = source.indexOf('{', start);
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  assert(i < source.length, `Client 的 ${name} 源码花括号不平衡`);
  const snippet = source.slice(start, i + 1);
  return new Function(`${snippet}; return ${name};`)();
}

async function clientFunctionWithWindow(name, windowValue, bindings = {}) {
  const source = await readFile(path.join(repoRoot, 'plugins', 'workbench', 'client.js'), 'utf8');
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `Client 缺少 ${name} 实现`);
  let depth = 0;
  let i = source.indexOf('{', start);
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  assert(i < source.length, `Client 的 ${name} 源码花括号不平衡`);
  const snippet = source.slice(start, i + 1);
  const names = Object.keys(bindings);
  return new Function('window', ...names, `${snippet}; return ${name};`)(windowValue, ...Object.values(bindings));
}

async function loadWorkbenchClient(React) {
  const source = await readFile(path.join(repoRoot, 'plugins', 'workbench', 'client.js'), 'utf8');
  let definition;
  runInNewContext(source, {
    window: { __ModuleLoader__: { load: (module) => { definition = module; } } },
  });
  assert(definition && definition.id === 'dsh-creator', 'Client 模块未通过 ModuleLoader 注册');
  return definition.factory((name) => {
    assert(name === 'react', `Client 请求了意外依赖：${name}`);
    return React;
  });
}

let pass = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// ---------------- 最小服务替身 ----------------

function makeFs() {
  return {
    async resolve(rel, opts) { return path.resolve((opts && opts.cwd) || '.', rel); },
    async readText(target) { return readFile(target, 'utf8'); },
    async stat(target) {
      try {
        const info = await fsStat(target);
        return { type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', size: info.size, version: `${info.mtimeMs}:${info.size}` };
      } catch (err) { return undefined; }
    },
    async writeText(target, text, expected) {
      const before = await this.stat(target);
      if (expected && expected.kind === 'replaceIfVersion') {
        if (!before || before.version !== expected.version) {
          const err = new Error('stale version');
          err.code = 'FS_STALE_VERSION';
          throw err;
        }
      }
      if (expected && expected.kind === 'createIfAbsent' && before) {
        const err = new Error('already exists');
        err.code = 'FS_NOT_OBSERVED';
        throw err;
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, text, 'utf8');
      const after = await this.stat(target);
      return { operation: before ? 'update' : 'create', version: after ? after.version : '' };
    },
    async listDir(target) {
      const entries = await readdir(target, { withFileTypes: true });
      return entries.map((e) => ({ type: e.isDirectory() ? 'directory' : 'file', name: e.name }));
    },
  };
}

async function harness(root, options) {
  const routes = [];
  const listeners = [];
  const webServer = {
    register(opts) { routes.push(opts); return () => {}; },
  };
  const services = options && options.withWebServer === false ? {} : { webServer };
  const fs = makeFs();
  const ctx = {
    get(name) {
      if (name === 'fs') return fs;
      if (name === 'sessions') return { get: (id) => (id === 's1' ? { header: { cwd: root } } : undefined) };
      if (name === 'sandboxPolicy') return { resolve: () => ({ policy: true }) };
      return services[name];
    },
    on(event, cb) {
      listeners.push({ event, cb });
      return () => {};
    },
  };
  const dispose = apply(ctx);
  return { ctx, routes, listeners, dispose, webServer, fs };
}

function call(route, method, action, payload) {
  return new Promise((resolve, reject) => {
    const req = new Readable({ read() {} });
    req.method = method;
    req.url = `${API_PREFIX}/${action}`;
    const res = {
      statusCode: 0,
      headers: {},
      body: '',
      setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
      end(chunk) {
        this.body = chunk || '';
        try { resolve({ status: this.statusCode, headers: this.headers, json: JSON.parse(this.body) }); } catch (err) { reject(new Error(`响应不是 JSON：${this.body.slice(0, 200)}`)); }
      },
    };
    Promise.resolve(route.handler(req, res)).catch(reject);
    if (payload !== undefined) req.push(JSON.stringify(payload));
    req.push(null);
  });
}

async function callOk(route, action, payload) {
  const res = await call(route, 'POST', action, payload);
  assert(res.status === 200, `${action} 应返回 200，实际 ${res.status}：${res.body}`);
  assert(res.json.ok === true, `${action} 返回 ok=false：${res.body}`);
  return res.json.data;
}

async function callErr(route, action, payload, status) {
  const res = await call(route, 'POST', action, payload);
  assert(res.status === status, `${action} 应返回 ${status}，实际 ${res.status}：${res.body}`);
  assert(res.json.ok === false, `${action} 应返回 ok=false`);
  return res.json.error;
}

async function absent(target) {
  try { await access(target); } catch (err) { return true; }
  return false;
}

// ---------------- 测试主体 ----------------

async function main() {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-creator-workbench-'));
  const root = path.join(base, 'workspace');
  await mkdir(root, { recursive: true });

  try {
    const h = await harness(root);
    assert(h.routes.length === 1, '应注册一条工作台路由');
    const route = h.routes[0];
    assert(route.kind === 'prefix', '路由应为 prefix');
    assert(route.path === API_PREFIX, '路由前缀应为 /creator-workbench/v1/api');

    await check('health 可诊断宿主挂载', async () => {
      const res = await call(route, 'GET', 'health');
      assert(res.status === 200 && res.json.data.plugin === 'creator-workbench', 'health 返回不正确');
    });

    await check('webServer 后出现时也能注册路由', async () => {
      const h2 = await harness(root, { withWebServer: false });
      assert(h2.routes.length === 0, '没有 webServer 时不应注册路由');
      assert(h2.listeners.length === 1 && h2.listeners[0].event === 'internal/service', '应监听 internal/service');
      h2.listeners[0].cb('webServer', h2.webServer);
      assert(h2.routes.length === 1, 'webServer 出现后应补注册路由');
      h2.dispose();
    });

    await check('空工作区 stats 为未初始化', async () => {
      const stats = await callOk(route, 'stats', { sessionId: 's1' });
      assert(stats.initialized === false, '空目录不应判定为已初始化');
      assert(stats.counts.chapters === 0, '空目录章节数应为 0');
    });

    await check('scaffold 建立完整工程骨架', async () => {
      const data = await callOk(route, 'scaffold', { sessionId: 's1', title: '长夜将至' });
      assert(data.created.length >= 10, '脚手架文件数量不足');
      assert(data.stats.initialized === true, '初始化后应判定为已初始化');
      assert(data.stats.title === '长夜将至', '作品名未写入 README');
      for (const rel of [PROJECT.readme, PROJECT.foreshadow, PROJECT.timeline, PROJECT.styleCard, `${PROJECT.outline}/总纲.md`, `${PROJECT.chapters}/说明.md`]) {
        await access(path.join(root, rel)).catch(() => { throw new Error(`缺少脚手架文件：${rel}`); });
      }
    });

    await check('new-chapter 自动续号并落盘', async () => {
      const data = await callOk(route, 'new-chapter', { sessionId: 's1', title: '雪夜' });
      assert(data.number === 1, '首章章号应为 1');
      assert(data.path === '正文/第001章-雪夜.md', `章节路径不符合约定：${data.path}`);
      await access(path.join(root, data.path));
    });

    await check('save 干净正文并返回零硬违规', async () => {
      const text = '雪落下来。\n\n他推开门，风灌进屋里，灯焰偏了一下。\n\n“走。”他说。\n';
      const data = await callOk(route, 'save', { sessionId: 's1', path: '正文/第001章-雪夜.md', content: text });
      assert(data.lint.hardCount === 0, `干净正文不应有硬违规：${JSON.stringify(data.lint.issues.slice(0, 3))}`);
      assert((await readFile(path.join(root, '正文', '第001章-雪夜.md'), 'utf8')) === text, '正文未写入');
    });

    await check('save 带硬违规仍落盘但返回检查结果', async () => {
      const bad = '他说：“走。”——然后停了。——又回头。\n';
      const data = await callOk(route, 'save', { sessionId: 's1', path: '正文/第001章-雪夜.md', content: bad });
      assert(data.lint.hardCount > 0, '破折号/直角引号应触发硬违规');
      assert(data.lint.issues.every((i) => i.level === 'hard' || i.level === 'soft'), 'issues 结构不正确');
      assert((await readFile(path.join(root, '正文', '第001章-雪夜.md'), 'utf8')) === bad, '硬违规正文也应保存（人工编辑不被门禁拦截）');
    });

    await check('lint 只检查不落盘', async () => {
      const data = await callOk(route, 'lint', { text: '他笑了笑，眼中闪过一丝无奈。' });
      assert(data.hardCount > 0 || data.softCount > 0, '套路表达应被检查出来');
      assert(typeof data.report === 'string' && data.report.length > 0, 'report 为空');
    });

    await check('路径越界被拒绝且不落盘', async () => {
      await callErr(route, 'save', { sessionId: 's1', path: '../evil.md', content: 'x' }, 400);
      await callErr(route, 'save', { sessionId: 's1', path: path.join(base, 'abs.md'), content: 'x' }, 400);
      assert(await absent(path.join(base, 'evil.md')), '越界文件被写入');
    });

    await check('超出 8 MiB 请求上限被拒绝且不落盘', async () => {
      await callErr(route, 'save', {
        sessionId: 's1', path: '正文/超大.md', content: 'x'.repeat(8 * 1024 * 1024),
      }, 413);
      assert(await absent(path.join(root, '正文', '超大.md')), '超大请求不应写入文件');
    });

    await check('点开头的隐藏路径段被拒绝（.history 等保留区不可写）', async () => {
      // 回归：normalizeRel 此前不拒点开头段，可把伪快照写进 .history/ 污染历史列表
      await callErr(route, 'save', { sessionId: 's1', path: '.history/正文/第001章-雪夜/99999999-999999-aaaa.md', content: '伪快照' }, 400);
      await callErr(route, 'save', { sessionId: 's1', path: '.hidden.md', content: 'x' }, 400);
      await callErr(route, 'save', { sessionId: 's1', path: '正文/.config/notes.md', content: 'x' }, 400);
      assert(await absent(path.join(root, '.history/正文/第001章-雪夜/99999999-999999-aaaa.md')), '伪快照被写入历史目录');
      assert(await absent(path.join(root, '.hidden.md')), '隐藏文件被写入');
    });

    await check('非 .md 与未知会话被拒绝', async () => {
      await callErr(route, 'save', { sessionId: 's1', path: '正文/notes.txt', content: 'x' }, 400);
      await callErr(route, 'stats', { sessionId: 'missing' }, 404);
      await callErr(route, 'stats', {}, 400);
    });

    await check('new-chapter 撞号返回 409', async () => {
      await callErr(route, 'new-chapter', { sessionId: 's1', number: 1 }, 409);
    });

    await check('stats 统计章节、字数与伏笔', async () => {
      await writeFile(path.join(root, PROJECT.foreshadow), '# 伏笔清单\n\n| 伏笔 | 铺设位置 | 发酵 | 回收位置 | 状态 |\n| --- | --- | --- | --- | --- |\n| 铜钥匙 | 第1章 | 3 | - | 未回收 |\n', 'utf8');
      const stats = await callOk(route, 'stats', { sessionId: 's1' });
      assert(stats.counts.chapters === 1, '章节数应为 1');
      assert(stats.counts.total > 0, '总字数应大于 0');
      assert(stats.foreshadow.open === 1, `未回收伏笔应为 1，实际 ${stats.foreshadow.open}`);
      assert(stats.chapters[0].num === 1 && stats.chapters[0].title === '雪夜', '章节元信息不正确');
      // 快捷视图数据：openItems 带清单文件物理行号（标题 1、空行 2、表头 3、
      // 分隔 4，铜钥匙在第 5 行）
      assert(Array.isArray(stats.foreshadow.openItems) && stats.foreshadow.openItems.length === 1, 'stats 应带出未回收条目列表');
      const item = stats.foreshadow.openItems[0];
      assert(item.name === '铜钥匙' && item.laidAt === 1 && item.line === 5, `未回收条目行号/章号不正确：${JSON.stringify(item)}`);
    });

    await check('save 检出外部修改并支持显式覆盖', async () => {
      const file = path.join(root, '正文', '第001章-雪夜.md');
      const base = await readFile(file, 'utf8');
      const first = await callOk(route, 'save', {
        sessionId: 's1', path: '正文/第001章-雪夜.md', content: '第一版：雪夜里的铜钥匙。\n', baseHash: hashText(base),
      });
      const oldHash = first.hash;
      await writeFile(file, '外部改写：助手在另一个窗口写入了新内容。\n', 'utf8');
      const err = await callErr(route, 'save', {
        sessionId: 's1', path: '正文/第001章-雪夜.md', content: '界面上的修改。\n', baseHash: oldHash,
      }, 409);
      assert(err.code === 'conflict', `冲突错误码不正确：${JSON.stringify(err)}`);
      assert((await readFile(file, 'utf8')).includes('外部改写'), '冲突保存不应覆盖磁盘内容');
      const forced = await callOk(route, 'save', {
        sessionId: 's1', path: '正文/第001章-雪夜.md', content: '最终版：雪夜里的铜钥匙。\n', force: true,
      });
      assert(forced.hash === hashText('最终版：雪夜里的铜钥匙。\n'), '覆盖保存后应返回新指纹');
    });

    await check('search 返回章节行号与上下文', async () => {
      const data = await callOk(route, 'search', { sessionId: 's1', query: '雪夜里的铜钥匙' });
      assert(data.total >= 1, '全文检索没有命中');
      const hit = data.results.find((r) => r.path === '正文/第001章-雪夜.md');
      assert(hit && hit.line === 1, `检索行号不正确：${JSON.stringify(data.results.slice(0, 3))}`);
      assert(hit.preview.includes('铜钥匙'), '检索片段缺少关键词');
    });

    await check('手工保存生成快照，历史列表与恢复可用', async () => {
      const rel = '正文/第001章-雪夜.md';
      const current = await readFile(path.join(root, rel), 'utf8');
      const saved = await callOk(route, 'save', {
        sessionId: 's1', path: rel, content: '第二版：这一版会被回滚掉。\n', baseHash: hashText(current), history: true,
      });
      assert(saved.snapshot && saved.snapshot.name, '手工保存没有生成历史快照');
      const snapText = await readFile(path.join(root, saved.snapshot.path), 'utf8');
      assert(snapText.includes('最终版'), '快照内容应为保存前的磁盘文本');
      const list = await callOk(route, 'history', { sessionId: 's1', path: rel });
      assert(list.snapshots[0].name === saved.snapshot.name, '历史列表没有按时间倒序返回最新快照');
      await callErr(route, 'restore', { sessionId: 's1', path: rel, snapshot: '../evil.md' }, 400);
      const restored = await callOk(route, 'restore', { sessionId: 's1', path: rel, snapshot: saved.snapshot.name });
      assert(restored.text.includes('最终版'), '恢复返回的文本不正确');
      assert(restored.snapshot && restored.snapshot.name, '恢复前应先给当前内容留快照');
      assert((await readFile(path.join(root, rel), 'utf8')).includes('最终版'), '磁盘内容没有被恢复到快照版本');
    });

    await check('scaffold 不覆盖已有工程', async () => {
      const err = await callErr(route, 'scaffold', { sessionId: 's1', title: '另一个作品' }, 409);
      assert(err.code === 'already-initialized', `重复初始化错误码不正确：${JSON.stringify(err)}`);
    });

    await check('index 重建 README 并带章节双链', async () => {
      const readmePath = path.join(root, PROJECT.readme);
      let readme = await readFile(readmePath, 'utf8');
      readme = readme.replace('- 简介：', '- 简介：雪夜求生').replace('- 状态：', '- 状态：连载中');
      await writeFile(readmePath, readme, 'utf8');
      const data = await callOk(route, 'index', { sessionId: 's1', title: '长夜将至' });
      assert(data.summary.includes('1 章'), `索引摘要不正确：${data.summary}`);
      const next = await readFile(readmePath, 'utf8');
      assert(next.includes('[[第001章-雪夜]]'), 'README 缺少章节双链');
      assert(next.includes('[[伏笔清单]]'), 'README 缺少追踪文件链接');
      assert(next.includes('- 简介：雪夜求生'), '整理索引不应清空作者简介');
      assert(next.includes('- 状态：连载中'), '整理索引不应清空作品状态');
      assert(next.includes('- 目标字数：'), '整理索引应保留目标字数行');
    });

    await check('工程内核：章节文件名与解析互逆', async () => {
      assert(chapterFile(7, '雨夜') === '正文/第007章-雨夜.md', 'chapterFile 输出不正确');
      const parsed = parseChapterFile('第007章-雨夜.md');
      assert(parsed && parsed.num === 7 && parsed.title === '雨夜', 'parseChapterFile 解析不正确');
      assert(parseChapterFile('说明.md') === null, '说明.md 不应被当作章节');
      // 回归：标题只含文件系统非法字符（/ \ : * ? " < > |、换行）时，清洗后为空
      // 应省略短横线，与无标题一致；此前会落成「第005章-.md」，同一章号出现
      // 「-.md」与「.md」两个文件，章节列表里同一章重复两行。
      assert(chapterFile(5, '/') === '正文/第005章.md', '非法字符标题清洗后应省略短横线');
      assert(chapterFile(5, 'a/b') === '正文/第005章-ab.md', '部分非法字符应清洗保留其余');
      assert(chapterFile(5, '  ') === '正文/第005章.md', '空白标题应视为无标题');
      assert(chapterFile(5, '') === '正文/第005章.md', '空标题应省略短横线');
    });

    await check('工程内核：字数口径与伏笔体检', async () => {
      assert(countChars('你好 world') === 3, '中英文字数口径不正确');
      const audit = auditForeshadow('| 伏笔 | 铺设位置 | 状态 |\n| --- | --- | --- |\n| 旧信 | 第1章 | 未回收 |\n', 30);
      assert(audit.total === 1 && audit.openCount === 1 && audit.stale.length === 1, '伏笔体检结果不正确');
      // open[] 未回收条目带清单行号（1 起，对应文件物理行）：表头第 1 行、
      // 分隔第 2 行，「旧信」在第 3 行——快捷视图点击直达就靠它
      assert(audit.open.length === 1 && audit.open[0].name === '旧信' && audit.open[0].line === 3, `未回收条目应带行号：${JSON.stringify(audit.open)}`);
      const auditClosed = auditForeshadow('| 伏笔 | 铺设位置 | 状态 |\n| --- | --- | --- |\n| 旧信 | 第1章 | 已回收 |\n', 30);
      assert(auditClosed.open.length === 0 && auditClosed.openCount === 0, '已回收条目不应出现在 open 列表');
      assert(hashText('') === '811c9dc5', '空文本指纹应为 FNV-1a 偏移基');
      assert(hashText('雪夜') === hashText('雪夜'), '指纹应稳定');
      const meta = readmeMeta('# 长夜\n\n- 简介：雪夜求生\n- 状态：连载中\n');
      assert(meta.title === '长夜' && meta.intro === '雪夜求生' && meta.status === '连载中', 'README 元信息提取不正确');
      const snapshot = snapshotName(new Date(2026, 10, 12, 23, 5, 7));
      assert(SNAPSHOT_NAME_RE.test(snapshot), `快照名格式不正确：${snapshot}`);
      assert(snapshot.startsWith('20261112-230507-'), '快照名应可按时间排序');
      assert(historyFolder('正文/第001章-雪夜.md') === '.history/正文/第001章-雪夜', '历史目录映射不正确');
    });

    await check('工程内核：全书体检游标分批与汇总口径', async () => {
      // 第 2 章带硬违规（分号），第 3 章带软违规（禁用词）；第 1 章此时是干净版
      await callOk(route, 'save', { sessionId: 's1', path: '正文/第002章-违硬.md', content: '他停下脚步；屋里没有灯。' });
      await callOk(route, 'save', { sessionId: 's1', path: '正文/第003章-违软.md', content: '他心中一沉，看着窗外。\n\n雨还在下，敲打着屋檐。' });
      const project = openProject(h.fs, root, undefined);
      const first = await scanBook(project, { offset: 0, batch: 2 });
      assert(first.scanned === 2 && first.chapters.length === 2, '第一批应扫 2 章');
      assert(first.next === 2, `第一批之后游标应为 2，实际 ${first.next}`);
      assert(first.total === 3 && first.truncated === true, '应报告总章数与未读完');
      const row2 = first.chapters[1];
      assert(row2.num === 2 && row2.hardCount > 0, `第 2 章应带硬违规：${JSON.stringify(row2)}`);
      const second = await scanBook(project, { offset: first.next, batch: 2 });
      assert(second.next === null && second.done === true, '第二批应读完且游标为 null');
      assert(second.chapters.some((r) => r.softCount > 0 && r.hardCount === 0), '禁用词章应只报建议');
      const totalHard = first.hardTotal + second.hardTotal;
      const totalScanned = first.scanned + second.scanned;
      assert(totalScanned === 3, `两批合计应扫 3 章，实际 ${totalScanned}`);
      assert(totalHard >= 1, '全书汇总硬违规数应 ≥1');
      // 每批只读该批章节：第一批结果不含第 3 章内容
      assert(first.chapters.every((r) => r.num <= 2), '第一批不应越界读第 3 章');
    });

    await check('scan 路由：分批参数与越界 offset', async () => {
      const first = await callOk(route, 'scan', { sessionId: 's1', offset: 0, batch: 2 });
      assert(first.scanned === 2 && first.next === 2, 'scan 路由第一批应扫 2 章');
      const again = await callOk(route, 'scan', { sessionId: 's1', offset: 99, batch: 2 });
      assert(again.scanned === 0 && again.next === null && again.done === true, '越界 offset 应返回空批且读完');
      assert(again.chapters.length === 0, '越界 offset 不应带章节行');
      await callErr(route, 'scan', {}, 400);
    });

    await check('工程内核：toPlainText 去格式保文字与空行分段', async () => {
      const md = [
        '# 第001章-雪夜',
        '',
        '他推开门，**风灌进屋里**。',
        '',
        '> 他想起[[林远|阿远]]的叮嘱。',
        '',
        '| 时间 | 事件 |',
        '| --- | --- |',
        '| 第一夜 | 抵达 |',
        '',
        '---',
        '',
        '- 检查门窗',
        '2. 点灯',
        '',
        '参考 [手册](https://example.com) 与 `代码`。',
      ].join('\n');
      const plain = toPlainText(md);
      assert(!plain.includes('#') && !plain.includes('**'), '标题符与强调符应被去除');
      assert(plain.includes('第001章-雪夜\n'), '章节标题应独立成行');
      assert(plain.includes('风灌进屋里'), '强调文字应保留');
      assert(plain.includes('阿远'), '双链别名应保留');
      assert(plain.includes('时间 · 事件'), '表格行应转为并列文本');
      assert(!plain.includes('| ---'), '表格分隔行应被丢弃');
      assert(!/\n{3,}/.test(plain), '不应有连续空段');
      assert(plain.includes('检查门窗'), '列表内容应保留');
      assert(!plain.includes('2.'), '有序列表符号应被去除');
      assert(plain.includes('参考 手册 与 代码。'), '链接保文字、行内代码去标记');
      assert(toPlainText('') === '', '空输入返回空串');
    });

    await check('工程内核：activityReport 从快照推保存次数/新增字数/连续天数', async () => {
      // 独立工作区：主流程的手工保存会产生今天的快照，混进来计数就对不上
      const actRoot = path.join(base, 'activity-workspace');
      await mkdir(path.join(actRoot, '正文'), { recursive: true });
      await writeFile(path.join(actRoot, '正文', '第001章-雪夜.md'), '雪落下来。\n', 'utf8');
      // 造 3 天快照：今天、昨天、3 天前（连续天数 = 2：今天+昨天）
      const now = new Date();
      const pad = (v) => String(v).padStart(2, '0');
      const key = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
      const day = (offsetDays) => {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offsetDays, 10, 0, 0);
        return `${key(d)}-100000-aaaa.md`;
      };
      const folder = path.join(actRoot, '.history', '正文', '第001章-雪夜');
      await mkdir(folder, { recursive: true });
      const sizes = [3000, 6000, 9000]; // 旧→新：每天新增约 1000 字（/3 近似）
      const names = [day(3), day(1), day(0)];
      for (let i = 0; i < names.length; i += 1) {
        await writeFile(path.join(folder, names[i]), 'x'.repeat(sizes[i]), 'utf8');
      }
      const io = openProject(h.fs, actRoot, undefined);
      const report = await activityReport(io, h.fs, actRoot, { now: now.getTime(), days: 14 });
      assert(report.days === 14, '默认窗口应为 14 天');
      assert(report.daily.length === 14, '应返回 14 个每日桶');
      const byKey = new Map(report.daily.map((d) => [d.key, d]));
      const today = byKey.get(key(now));
      const yesterday = byKey.get(key(new Date(now.getTime() - 86400000)));
      assert(today && today.saves === 1, `今天应记 1 次保存：${JSON.stringify(today)}`);
      assert(yesterday && yesterday.saves === 1, '昨天应记 1 次保存');
      assert(today.added >= 900 && today.added <= 1100, `今天新增应约 1000 字（6000→9000 差 3000 字节 /3）：${JSON.stringify(today)}`);
      assert(report.streak === 2, `今天+昨天应连续 2 天，实际 ${report.streak}`);
      assert(report.writingDays === 3, `快照覆盖 3 天（3 天前/昨天/今天），写作天数应为 3，实际 ${report.writingDays}`);
      // 没有快照的日子保存次数应为 0（3 天前有快照，2 天前没有）
      assert(byKey.get(key(new Date(now.getTime() - 2 * 86400000))).saves === 0, '没有快照的日子保存次数应为 0');
      assert(byKey.get(key(new Date(now.getTime() - 3 * 86400000))).saves === 1, '3 天前的快照应记 1 次保存');
      // 自定义窗口生效
      const narrow = await activityReport(io, h.fs, actRoot, { now: now.getTime(), days: 7 });
      assert(narrow.days === 7 && narrow.daily.length === 7, '自定义窗口应生效');
    });

    await check('工程内核：activityReport 空工程优雅空态', async () => {
      const emptyRoot = path.join(base, 'empty-workspace');
      await mkdir(emptyRoot, { recursive: true });
      const io = openProject(h.fs, emptyRoot, undefined);
      const report = await activityReport(io, h.fs, emptyRoot, { days: 14 });
      assert(report.writingDays === 0 && report.streak === 0, '无数据应返回零值空态');
      assert(report.daily.every((d) => d.saves === 0 && d.added === 0), '无数据时每日桶应全为 0');
      assert(report.activeDays.length === 0, '无数据时写作日列表应为空');
    });

    await check('工程内核：目标解析与 README 目标行写入', async () => {
      // parseGoal：数字（含万）、日期格式、非法值全按无目标处理
      assert(parseGoal(readmeMeta('- 目标字数：800000\n')) .chars === 800000, '纯数字目标应原样解析');
      assert(parseGoal(readmeMeta('- 目标字数：120万\n')).chars === 1200000, '「万」单位应换算');
      assert(parseGoal(readmeMeta('- 目标字数：1,200,000\n')).chars === 1200000, '千分位应忽略');
      assert(parseGoal(readmeMeta('- 目标完稿：2026/2/5\n')).date === '2026-02-05', '斜杠日期应归一为 ISO');
      assert(parseGoal(readmeMeta('- 目标字数：越多越好\n')) === null, '解析不出的字数按无目标');
      assert(parseGoal(readmeMeta('- 目标完稿：2026-13-99\n')) === null, '非法日期按无目标');
      assert(parseGoal(readmeMeta('')) === null, '无目标行返回 null');
      // writeGoal：写入原位替换、缺行追加、清除删行、不破坏其他内容
      const base = '# 长夜\n\n- 简介：雪夜求生\n- 状态：连载中\n\n## 章节\n\n- [[第001章-雪夜]]\n';
      const withGoal = writeGoal(base, { chars: 800000, date: '2026-12-31' });
      assert(withGoal.includes('- 目标字数：800000') && withGoal.includes('- 目标完稿：2026-12-31'), '目标行应写入');
      assert(withGoal.includes('- 简介：雪夜求生') && withGoal.includes('- [[第001章-雪夜]]'), '写目标不应破坏其他内容');
      const replaced = writeGoal(withGoal, { chars: 1000000 });
      assert(replaced.includes('- 目标字数：1000000') && !replaced.includes('800000'), '改写字数应原位替换');
      assert(replaced.includes('- 目标完稿：2026-12-31'), '改写字数不应动日期行');
      const cleared = writeGoal(replaced, { chars: null, date: null });
      assert(!cleared.includes('目标字数') && !cleared.includes('目标完稿'), '清除应删掉两行');
      assert(cleared.includes('- 简介：雪夜求生'), '清除不应动简介');
      const regoal = writeGoal(cleared, { chars: 500000, date: '2027-06-01' });
      assert(regoal.includes('- 目标字数：500000') && regoal.includes('- 目标完稿：2027-06-01'), '清除后重新设置应插回元信息块');
      assert(regoal.indexOf('- 目标字数：500000') < regoal.indexOf('## 章节'), '目标行应插在章节标题之前');
    });

    await check('activity 路由：返回每日桶与空态', async () => {
      const data = await callOk(route, 'activity', { sessionId: 's1', days: 14 });
      assert(data.days === 14 && data.daily.length === 14, 'activity 路由应返回 14 天窗口');
      assert(typeof data.streak === 'number' && typeof data.writingDays === 'number', '应返回连续天数与写作天数');
      await callErr(route, 'activity', {}, 400);
    });

    await check('工程内核：diffLines 行级 diff 增删改统计与上下文折叠', async () => {
      // 基本增删改：旧 4 行 → 新 4 行，其中 1 行改写、1 行删除、1 行新增
      const old1 = '第一行\n第二行\n第三行\n第四行';
      const new1 = '第一行\n第二行（改过）\n第三行\n插入的新行\n第四行';
      const d1 = diffLines(old1, new1);
      assert(d1.truncated === false, '短文本不应降级');
      assert(d1.stats.oldLines === 4 && d1.stats.newLines === 5, 'diff 行数统计不正确');
      assert(d1.stats.changed === 1, `改写行应配对成 1 处修改：${JSON.stringify(d1.stats)}`);
      assert(d1.stats.added === 1 && d1.stats.removed === 0, '独立插入行应只计新增，不计删除');
      const modRow = d1.rows.find((r) => r.type === 'mod');
      assert(modRow && modRow.text === '第二行（改过）' && modRow.oldText === '第二行', '修改行应同时带新文本与原文本');
      assert(d1.rows.some((r) => r.type === 'add' && r.text === '插入的新行'), '新增行应带文本');
      // 相同文本零差异
      const d2 = diffLines('甲\n乙\n丙', '甲\n乙\n丙');
      assert(d2.stats.added === 0 && d2.stats.removed === 0 && d2.stats.changed === 0 && d2.stats.unchanged === 3, '相同文本应零差异');
      assert(d2.rows.every((r) => r.type === 'same'), '无变更时不应有折叠标记');
      // 空文本 vs 有内容：全部计新增
      const d3 = diffLines('', '甲\n乙');
      assert(d3.stats.added === 2 && d3.stats.removed === 0, '空快照到有内容应全计新增');
      const d4 = diffLines('甲\n乙', '');
      assert(d4.stats.removed === 2 && d4.stats.added === 0, '有内容到空文件应全计删除');
      // 上下文折叠：长段未变行折叠成 skip 标记，默认保留前后 2 行
      const unchanged = Array.from({ length: 30 }, (_, i) => `未变行${i}`).join('\n');
      const d5 = diffLines(`${unchanged}\n旧结尾`, `${unchanged}\n新结尾`);
      const skips = d5.rows.filter((r) => r.type === 'skip');
      assert(skips.length === 1 && skips[0].count > 0, '长段未变行应折叠成一个 skip 块');
      assert(d5.rows.filter((r) => r.type === 'mod').length === 1, '结尾改写应被识别');
      assert(d5.rows.length <= 8, `上下文压缩后行数应远小于全文：${d5.rows.length}`);
      // 长章节性能保护：超过 800 行降级为仅统计（rows=null），多重集合口径仍可靠
      const bigOld = Array.from({ length: 1000 }, (_, i) => `行${i}`).join('\n');
      const bigNew = Array.from({ length: 1000 }, (_, i) => (i === 500 ? `行${i}改` : `行${i}`)).join('\n');
      const d6 = diffLines(bigOld, bigNew);
      assert(d6.truncated === true && d6.rows === null, '超限应降级为仅统计且不带逐行结果');
      assert(d6.stats.oldLines === 1000 && d6.stats.newLines === 1000, '降级统计应保留两侧行数');
      assert(d6.stats.added === 1 && d6.stats.removed === 1, `降级模式改写应计成一对增删：${JSON.stringify(d6.stats)}`);
      // 行数上限可调（下限钳到 50）：传一个低于实际行数的上限即可触发降级
      const small = Array.from({ length: 60 }, (_, i) => `行${i}`).join('\n');
      const d7 = diffLines(small, `${small}\n新增行`, { maxLines: 50 });
      assert(d7.truncated === true && d7.rows === null, '低于实际行数的 maxLines 应触发降级');
      assert(d7.stats.added === 1, '降级统计仍应算出新增');
    });

    await check('diff 路由：快照与当前对比、非法参数与降级', async () => {
      const rel = '正文/第001章-雪夜.md';
      // 先造一次手工保存产生快照（当前磁盘文本会存为快照）
      const current = await readFile(path.join(root, rel), 'utf8');
      const saved = await callOk(route, 'save', {
        sessionId: 's1', path: rel, content: `${current}新追加的一段。\n`, baseHash: hashText(current), history: true,
      });
      assert(saved.snapshot && saved.snapshot.name, '对比前置：手工保存应生成快照');
      const data = await callOk(route, 'diff', { sessionId: 's1', path: rel, snapshot: saved.snapshot.name });
      assert(data.path === rel && data.snapshot === saved.snapshot.name, 'diff 路由应回显路径与快照名');
      assert(data.exists === true, '当前文件存在时应回显 exists=true');
      assert(data.truncated === false && Array.isArray(data.rows), '短章节应返回逐行差异');
      assert(data.stats.added === 1, `快照 → 当前应计 1 行新增：${JSON.stringify(data.stats)}`);
      assert(data.rows.some((r) => r.type === 'add' && r.text.includes('新追加的一段')), '差异行应包含新增内容');
      // 非法参数：非 .md、伪快照名、未知会话
      await callErr(route, 'diff', { sessionId: 's1', path: '正文/notes.txt', snapshot: 'x' }, 400);
      await callErr(route, 'diff', { sessionId: 's1', path: rel, snapshot: '../evil.md' }, 400);
      await callErr(route, 'diff', { sessionId: 's1', path: rel, snapshot: '不存在.md' }, 400);
      await callErr(route, 'diff', { sessionId: 'missing', path: rel, snapshot: saved.snapshot.name }, 404);
      // 路径越界拒绝
      await callErr(route, 'diff', { sessionId: 's1', path: '../outside.md', snapshot: saved.snapshot.name }, 400);
    });

    await check('工程内核：findBacklinkHits 双链引用解析', async () => {
      const text = [
        '他推开门，想起[[林远]]的叮嘱。',
        '设定见[[人物卡/林远|阿远]]。',
        '这一行没有双链。',
        'another[[林远心传]]不算。',
        '[[林远]] 第二次出现',
      ].join('\n');
      const hits = findBacklinkHits(text, '正文/第001章-雪夜.md', '林远');
      assert(hits.length === 3, `应命中 3 行（裸名、带目录别名、重复行），实际 ${hits.length}`);
      assert(hits[0].line === 1 && hits[1].line === 2 && hits[2].line === 5, '命中行号应正确');
      assert(hits[0].preview.includes('林远'), '预览应带上下文文字');
      // 子串名词不算：[[林远心传]] 不引用 [[林远]]
      assert(!hits.some((h) => h.line === 4), '更长的双链名词不应被误判为引用');
      // 反向：目标带目录路径时，裸名与带目录写法都算
      const dirHits = findBacklinkHits(text, '正文/第001章-雪夜.md', '人物卡/林远.md');
      assert(dirHits.length === 3, `目标带目录时应按基名匹配，实际 ${dirHits.length}`);
      // README 整理索引生成的带目录双链指向章节
      const readme = '- [[第001章-雪夜]]\n- [[伏笔清单]]\n';
      const chapterHits = findBacklinkHits(readme, 'README.md', '正文/第001章-雪夜.md');
      assert(chapterHits.length === 1 && chapterHits[0].line === 1, '整理索引的章节双链应被识别为反链');
      assert(findBacklinkHits(readme, 'README.md', '时间线.md').length === 0, '不相关目标不应命中');
      // 自引用排除
      assert(findBacklinkHits('# 林远\n[[林远]]', '人物卡/林远.md', '人物卡/林远.md').length === 0, '文件引用自己不算反链');
      // 非法目标
      assert(findBacklinkHits('[[x]]', 'a.md', '').length === 0, '空目标返回空');
      assert(findBacklinkHits('[[.hidden]]', 'a.md', '.hidden').length === 0, '点开头目标拒绝');
      assert(findBacklinkHits('', 'a.md', '林远').length === 0, '空文本返回空');
    });

    await check('工程内核：scanBacklinks 工程级反链扫描', async () => {
      const project = openProject(h.fs, root, undefined);
      // 当前主工作区：README 里有 [[第001章-雪夜]]（整理索引测试写入），
      // 人物卡尚无引用林远的文件 → 先给林远建档并让第 1 章引用
      const data = await scanBacklinks(project, '正文/第001章-雪夜.md');
      assert(data.target === '正文/第001章-雪夜.md', '应回显目标路径');
      assert(data.scanned >= 5, `应扫描正文+目录+追踪文件全集，实际 ${data.scanned}`);
      assert(data.references.some((r) => r.path === 'README.md' && r.line >= 1), 'README 的章节双链应进反链列表');
      // 指定文件列表：只扫给定的文件
      const narrow = await scanBacklinks(project, '正文/第001章-雪夜.md', { files: ['README.md', '正文/第001章-雪夜.md'] });
      assert(narrow.scanned === 1, '自引用文件应被跳过，实际只扫 1 个');
      assert(narrow.references.length === data.references.filter((r) => r.path === 'README.md').length, '窄扫描与全量扫描的 README 命中一致');
      // 非 .md 目标返回空
      const bad = await scanBacklinks(project, '正文/notes.txt');
      assert(bad.scanned === 0 && bad.references.length === 0, '非 .md 目标应返回空扫描');
    });

    await check('backlinks 路由：反链列表与非法参数', async () => {
      const data = await callOk(route, 'backlinks', { sessionId: 's1', path: '正文/第001章-雪夜.md' });
      assert(data.target === '正文/第001章-雪夜.md', 'backlinks 路由应回显目标');
      assert(Array.isArray(data.references), '应返回引用列表');
      assert(data.references.some((r) => r.path === 'README.md'), 'README 对章节的引用应出现在反链里');
      assert(data.references.every((r) => r.path !== '正文/第001章-雪夜.md'), '自引用不应出现在反链里');
      await callErr(route, 'backlinks', { sessionId: 's1', path: '正文/notes.txt' }, 400);
      await callErr(route, 'backlinks', { sessionId: 's1', path: '../evil.md' }, 400);
      await callErr(route, 'backlinks', { sessionId: 'missing', path: 'README.md' }, 404);
    });

    await check('goal 路由：写入、改写、清除与非法参数', async () => {
      // 写入目标 → stats 带出 goal
      const set = await callOk(route, 'goal', { sessionId: 's1', chars: 800000, date: '2026-12-31' });
      assert(set.goal && set.goal.chars === 800000 && set.goal.date === '2026-12-31', `goal 写入返回不正确：${JSON.stringify(set.goal)}`);
      const stats = await callOk(route, 'stats', { sessionId: 's1' });
      assert(stats.goal && stats.goal.chars === 800000, 'stats 应带出 README 里的写作目标');
      const readme1 = await readFile(path.join(root, PROJECT.readme), 'utf8');
      assert(readme1.includes('- 目标字数：800000'), '目标字数应写进 README');
      assert(readme1.includes('- 简介：雪夜求生'), '写目标不应破坏已有简介');
      // 只改日期，字数保留（字段缺省 = 该行不动）
      await callOk(route, 'goal', { sessionId: 's1', date: '2027-01-15' });
      const readme2 = await readFile(path.join(root, PROJECT.readme), 'utf8');
      assert(readme2.includes('- 目标字数：800000') && readme2.includes('- 目标完稿：2027-01-15'), '改写应只动对应行');
      // 只改字数，日期保留；再只清字数，日期仍在
      await callOk(route, 'goal', { sessionId: 's1', chars: 1000000 });
      const readme2b = await readFile(path.join(root, PROJECT.readme), 'utf8');
      assert(readme2b.includes('- 目标字数：1000000') && readme2b.includes('- 目标完稿：2027-01-15'), '单字段改写应保留另一字段');
      await callOk(route, 'goal', { sessionId: 's1', chars: null });
      const readme2c = await readFile(path.join(root, PROJECT.readme), 'utf8');
      assert(!readme2c.includes('目标字数') && readme2c.includes('- 目标完稿：2027-01-15'), '单字段清除应只删对应行');
      // 清除（显式 null；两行都移除）
      await callOk(route, 'goal', { sessionId: 's1', chars: null, date: null });
      const statsCleared = await callOk(route, 'stats', { sessionId: 's1' });
      assert(statsCleared.goal === null, '清除后 stats.goal 应为 null');
      const readme3 = await readFile(path.join(root, PROJECT.readme), 'utf8');
      assert(!readme3.includes('目标字数'), '清除后 README 不应再含目标行');
      assert(readme3.includes('- 简介：雪夜求生'), '清除不应破坏简介');
      // 非法参数拒绝且不落盘
      await callErr(route, 'goal', { sessionId: 's1' }, 400);
      await callErr(route, 'goal', { sessionId: 's1', chars: -5 }, 400);
      await callErr(route, 'goal', { sessionId: 's1', date: 'tomorrow' }, 400);
      await callErr(route, 'goal', { sessionId: 'missing' }, 404);
    });

    h.dispose();
  } finally {
    await rm(base, { recursive: true, force: true });
  }

  await check('Client 与服务端内容指纹一致', async () => {
    const source = await readFile(path.join(repoRoot, 'plugins', 'workbench', 'client.js'), 'utf8');
    const match = source.match(/function hashText\(text\) \{([\s\S]*?)\n    \}/);
    assert(match, 'Client 缺少 hashText 实现');
    const clientHash = new Function('text', match[1]);
    for (const sample of ['', '雪夜', '第001章\n\n他推开门。\n']) {
      assert(clientHash(sample) === hashText(sample), `前后端指纹不一致：${JSON.stringify(sample)}`);
    }
  });

  await check('Client 草稿保护：恢复草稿带回旧基线指纹，confirm 缺失不静默丢稿', async () => {
    const source = await readFile(path.join(repoRoot, 'plugins', 'workbench', 'client.js'), 'utf8');
    // 回归 1：恢复本地草稿且磁盘已变时，必须把草稿基线（cached.baseHash）带回
    // current.hash，否则保存时 baseHash 恒等于磁盘指纹，409 冲突保护永不触发。
    assert(source.includes('nextHash = cached.baseHash'),
      '恢复草稿时未把草稿基线指纹设为 current.hash（冲突保护会失效）');
    assert(/let nextHash = hashText\(text\);/.test(source), '缺省应取磁盘文本指纹');
    assert(/setCurrent\(\{ path, text, hash: nextHash \}\)/.test(source), '打开文件应使用 nextHash');
    // 回归 2：window.confirm 不可用的宿主里，旧的 `typeof window.confirm !== 'function'
    // || confirm(...)` 写法会按「确认放弃」处理，静默清掉草稿缓存。现在必须挡下操作。
    assert(!source.includes("typeof window.confirm !== 'function'\n            || window.confirm"),
      'openFile 等路径不得再使用「confirm 缺失即放行」的旧写法');
    for (const guard of ['if (!canConfirm()) {']) {
      assert(source.includes(guard), `缺少 confirm 缺失守卫：${guard}`);
    }
    // 关键丢失路径都有守卫：切文件、回总览、新建章节、恢复历史、切换助手
    for (const fn of ['const openFile = ', 'const goHome = ', 'const createChapter = ', 'const restoreSnapshot = ', 'const switchAssistant = ']) {
      const start = source.indexOf(fn);
      assert(start >= 0, `缺少函数：${fn}`);
      const body = source.slice(start, source.indexOf('\n      }, [', start));
      assert(body.includes('canConfirm()'), `「${fn.trim()}」在 confirm 缺失时未保护未保存修改`);
    }
  });

  await check('Client 草稿缓存：不可写/超限返回失败并提示手动保留', async () => {
    let writes = 0;
    const storage = {
      setItem() { writes += 1; },
      getItem() { return null; },
      removeItem() {},
    };
    const cacheBindings = {
      DRAFT_CACHE_LIMIT: 2000000,
      draftCacheKey: (sessionId, filePath) => `dsh-creator:draft:${sessionId}:${filePath}`,
    };
    const save = await clientFunctionWithWindow('saveDraftCache', { localStorage: storage }, cacheBindings);
    assert(save('s1', '正文/第001章.md', '草稿', 'base') === true && writes === 1, '正常 localStorage 应保存草稿');
    assert(save('s1', '正文/第001章.md', 'x'.repeat(2000001), 'base') === false && writes === 1, '超限草稿不得写入缓存');
    const failing = await clientFunctionWithWindow('saveDraftCache', {
      localStorage: { setItem() { throw new Error('quota'); } },
    }, cacheBindings);
    assert(failing('s1', '正文/第001章.md', '草稿', 'base') === false, 'localStorage 异常应返回失败');
    const source = await readFile(path.join(repoRoot, 'plugins', 'workbench', 'client.js'), 'utf8');
    assert(source.includes('本机草稿暂存失败，已阻止切换会话；请先复制当前内容。'), '缓存失败应提示用户先复制内容');
    assert(source.includes('草稿已保留在本地缓存'), 'confirm 不可用时应提示草稿仍被保留');
  });

  await check('Client 会话切换：先暂存草稿并确认，主会话自动切换共用保护', async () => {
    const guard = await clientFunction('checkWorkbenchSessionSwitch');
    let confirmations = 0;
    const dirtySaved = () => ({ dirty: true, saved: true });
    const unchanged = guard('s1', 's1', dirtySaved, () => { confirmations += 1; return true; });
    assert(unchanged.allowed && !unchanged.changed && confirmations === 0, '同会话不应触发确认');
    const clean = guard('s1', 's2', () => ({ dirty: false, saved: true }), () => { confirmations += 1; return true; });
    assert(clean.allowed && clean.changed && confirmations === 0, '无修改时应直接允许切换');
    const failed = guard('s1', 's2', () => ({ dirty: true, saved: false }), () => { confirmations += 1; return true; });
    assert(!failed.allowed && failed.reason === 'draft-save-failed' && confirmations === 0, '暂存失败必须阻止切换且不可询问确认');
    const canceled = guard('s1', 's2', dirtySaved, () => { confirmations += 1; return false; });
    assert(!canceled.allowed && canceled.reason === 'confirmation-required' && confirmations === 1, '取消确认后必须留在当前会话');
    const noConfirm = guard('s1', 's2', dirtySaved, undefined);
    assert(!noConfirm.allowed && noConfirm.reason === 'confirmation-required', 'confirm 不可用时不能丢弃草稿或切换');
    const accepted = guard('s1', 's2', dirtySaved, () => { confirmations += 1; return true; });
    assert(accepted.allowed && accepted.changed && confirmations === 2, '草稿成功暂存并确认后应允许切换');
    const order = [];
    guard('s1', 's2', () => { order.push('stash'); return { dirty: true, saved: true }; }, () => { order.push('confirm'); return true; });
    assert(order.join(',') === 'stash,confirm', '会话切换必须在确认前先同步暂存草稿');
    const source = await readFile(path.join(repoRoot, 'plugins', 'workbench', 'client.js'), 'utf8');
    assert(source.includes('switchSession(activeId)'), '主会话自动切换未复用统一草稿保护');
    assert(source.includes('switchSession(next)'), '会话选择器未复用统一草稿保护');
    assert(source.includes('session.cwd && session.origin !== \'subagent\''), '会话选择器必须排除无工作区及 subagent 会话');
    assert(/const nextDraft = ev\.target\.value;\s+const nextDirty = nextDraft !== current\.text;\s+draftRef\.current = nextDraft;\s+editSnapshotRef\.current = \{ dirty: nextDirty, current, draft: nextDraft, mode: 'edit', sessionId \};\s+setDraft\(nextDraft\)/.test(source),
      '编辑器必须同步更新草稿 ref，避免切换时取到上一帧内容');
  });

  await check('Client 插槽注册：左栏入口关联主面板且只列可用工作区会话', async () => {
    const hookFrame = { current: null };
    const React = {
      createElement(type, props, ...children) {
        return { type, props: { ...(props || {}), children: children.length === 1 ? children[0] : children } };
      },
      useState(initial) {
        const frame = hookFrame.current;
        const index = frame.index++;
        if (!(index in frame.state)) frame.state[index] = typeof initial === 'function' ? initial() : initial;
        return [frame.state[index], (next) => { frame.state[index] = typeof next === 'function' ? next(frame.state[index]) : next; }];
      },
      useEffect() { hookFrame.current.index += 1; },
      useMemo(factory) { hookFrame.current.index += 1; return factory(); },
      useCallback(callback) { hookFrame.current.index += 1; return callback; },
      useRef(initial) {
        const frame = hookFrame.current;
        const index = frame.index++;
        if (!(index in frame.state)) frame.state[index] = { current: initial };
        return frame.state[index];
      },
    };
    const module = await loadWorkbenchClient(React);
    const registrations = [];
    const injections = [];
    let sessionListener;
    const sessions = [
      { id: 's-main', cwd: '/workspace/main', displayTitle: '主会话', retainedBy: { mainView: 1 } },
      { id: 's-other', cwd: '/workspace/other', displayTitle: '另一个作品', retainedBy: {} },
      { id: 's-no-workspace', displayTitle: '无工作区', retainedBy: {} },
      { id: 's-child', cwd: '/workspace/child', origin: 'subagent', displayTitle: '子任务', retainedBy: {} },
    ];
    const snapshot = { ids: sessions.map((session) => session.id), byId: Object.fromEntries(sessions.map((session) => [session.id, session])) };
    const ctx = {
      slots: {
        inject(name, callback) { injections.push({ name, callback }); return { name }; },
        register(options, component) { const entry = { options, component }; registrations.push(entry); return entry; },
      },
      sessions: { list: { getSnapshot: () => snapshot, subscribe: (listener) => { sessionListener = listener; return () => {}; } } },
      effect(effect) { return effect(); },
    };
    module.apply(ctx);
    assert(typeof sessionListener === 'function', 'Client 未订阅主会话变更');
    const mainInjection = injections.find((entry) => entry.name === 'main');
    assert(mainInjection, '没有注入 main 主面板槽');
    const generator = mainInjection.callback();
    generator.next();
    generator.next();
    const sidebarInjection = injections.find((entry) => entry.name === 'sidebar.panellist');
    assert(sidebarInjection, '没有注入 sidebar.panellist 入口');
    sidebarInjection.callback();
    const main = registrations.find((entry) => entry.options.name === 'main');
    const sidebar = registrations.find((entry) => entry.options.name === 'sidebar.panellist');
    assert(main && sidebar, '主面板或侧栏入口没有注册');
    assert(main.options.key === sidebar.options.id, '侧栏入口 ID 必须与 main 面板 key 一致');
    assert(sidebar.options.order < 0, '工作台入口应排在工作区浏览列表上方');

    const mainElement = main.component({ useSessions: (selector) => selector(snapshot) });
    const previousFrame = hookFrame.current;
    hookFrame.current = { index: 0, state: [] };
    let panelTree;
    try { panelTree = mainElement.type(mainElement.props); } finally { hookFrame.current = previousFrame; }
    const find = (node, predicate) => {
      if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
      if (!node || typeof node !== 'object') return undefined;
      if (predicate(node)) return node;
      return find(node.props && node.props.children, predicate);
    };
    const select = find(panelTree, (node) => node.type === 'select');
    assert(select && select.props.value === 's-main', '首次打开应选中当前主会话');
    const optionValues = [];
    const visitOptions = (node) => {
      if (Array.isArray(node)) { for (const child of node) visitOptions(child); return; }
      if (!node || typeof node !== 'object') return;
      if (node.type === 'option') optionValues.push(node.props.value);
      visitOptions(node.props && node.props.children);
    };
    visitOptions(select.props.children);
    assert(optionValues.includes('s-main') && optionValues.includes('s-other'), '应列出有工作区的主会话与普通会话');
    assert(!optionValues.includes('s-no-workspace') && !optionValues.includes('s-child'), '不得列出无工作区或 subagent 会话');
  });

  await check('Bundle contract：依赖、exports、locale 与所有 skills 缺项可诊断', async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
    assert(REQUIRED_CLIENT_DEPENDENCIES.every((dependency) => pkg.dsh.client.inject.includes(dependency)), 'bundle manifest 缺少 required client dependency');
    assert(inspectBundleContract(pkg, repoRoot).length === 0, '仓库当前发布目录应满足完整 bundle contract');

    const missingDependency = structuredClone(pkg);
    missingDependency.dsh.client.inject = missingDependency.dsh.client.inject.filter((dependency) => dependency !== '@deepseek-ai/dsh-client-ui-sidebar');
    assert(inspectBundleContract(missingDependency, repoRoot).some((error) => error.includes('dsh.client.inject 缺少依赖 @deepseek-ai/dsh-client-ui-sidebar')),
      '缺少客户端依赖时必须给出依赖名称诊断');

    const missingExport = structuredClone(pkg);
    delete missingExport.exports['./client'];
    assert(inspectBundleContract(missingExport, repoRoot).some((error) => error.includes('exports["./client"]')),
      '缺少 client export 时必须给出 export 路径诊断');

    const missingLocale = inspectBundleContract(pkg, repoRoot, {
      exists: (target) => target !== path.join(repoRoot, 'plugins/workbench/locale/en.json'),
    });
    assert(missingLocale.some((error) => error.includes('plugins/workbench/locale/en.json')),
      '缺少 locale 必须阻断并报告具体文件');
    const missingSkill = inspectBundleContract(pkg, repoRoot, {
      listDir: (target) => target === path.join(repoRoot, 'skills') ? [{ name: 'test-skill', isDirectory: () => true }] : [],
      exists: (target) => target !== path.join(repoRoot, 'skills/test-skill/SKILL.md'),
    });
    assert(missingSkill.some((error) => error.includes('skills/test-skill/SKILL.md')),
      '缺少任一 skill 文件必须被发现');
  });

  await check('DSH 兼容性预检：最低版本、旧编辑器与重复 bundle', async () => {
    assert(compareVersions('0.2.2-rc.2', MIN_SUPPORTED_DSH) === 0, '最低支持版本比较不正确');
    assert(compareVersions('0.2.2-rc.10', '0.2.2-rc.2') > 0, '预发布数字版本段应按数值比较');
    assert(compareVersions('0.2.2', '0.2.2-rc.2') > 0, '正式版应高于同版本预发布版');
    const tooOld = checkCompatibility('0.2.2-rc.1');
    assert(tooOld.errors.some((error) => error.includes(MIN_SUPPORTED_DSH)), '过低 DSH 版本必须拒绝并说明升级下限');
    const legacy = checkCompatibility('0.2.2-rc.2', ['dsh-creator', 'dsh-novel-editor']);
    assert(legacy.errors.length === 0 && legacy.warnings.some((warning) => warning.includes('dsh-novel-editor')),
      '旧独立编辑器并存应显示迁移提示');
    const duplicate = checkCompatibility('0.2.2-rc.2', ['dsh-creator', 'dsh-creator']);
    assert(duplicate.errors.some((error) => error.includes('重复项')), '重复 bundle 必须给出诊断');
    assert(checkCompatibility('not-a-version').errors.length > 0, '无法解析 DSH 版本时必须拒绝预检');
    const cli = spawnSync(process.execPath, ['check-compat.mjs', '--dsh-version', '0.2.2-rc.1'], {
      cwd: path.join(repoRoot, 'tools'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert(cli.status === 1 && cli.stderr.includes('要求 DSH >= 0.2.2-rc.2'), '兼容性 CLI 必须以失败码输出可操作的版本下限诊断');
  });

  await check('编辑器已并入主包，不再有独立 bundle', async () => {
    assert(await absent(path.join(repoRoot, 'plugins-dsh')), 'plugins-dsh 仍存在');
    await access(path.join(repoRoot, 'plugins', 'workbench', 'client.js'));
    await access(path.join(repoRoot, 'plugins', 'workbench', 'index.js'));
    assert(await absent(path.join(repoRoot, 'agent.cordis.yml')), 'agent.cordis.yml 旧安装路线仍存在');
  });

  await check('package.json：dsh.client 与 exports 指向工作台', async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
    assert(pkg.version === '2.6.0', `版本应升到 2.6.0，实际 ${pkg.version}`);
    assert(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web', '缺少 dsh.client.platform=web');
    assert(pkg.dsh.client.immediately === true, '工作台应随 bootstrap 立即注册');
    for (const dependency of REQUIRED_CLIENT_DEPENDENCIES) {
      assert(pkg.dsh.client.inject.includes(dependency), `dsh.client.inject 缺少侧栏工作台依赖：${dependency}`);
    }
    assert(pkg.exports['./client'] === './plugins/workbench/client.js', 'exports ./client 未指向工作台');
    assert(pkg.exports['.'] === './plugins/workbench/index.js', '包根未指向工作台 Host');
    assert(pkg.files.includes('skills'), '发布包未包含 skills');
    assert(pkg.dsh.bundle.patch === './cordis.patch.yml', 'bundle patch 声明不正确');
    const patch = await readFile(path.join(repoRoot, 'cordis.patch.yml'), 'utf8');
    assert(/name:\s*'dsh-creator'\s*$/m.test(patch), '工作台负载行必须使用包根名（客户端发现依赖包根）');
    assert(!patch.includes('dsh-creator/plugins/workbench/index.js'), '工作台负载行不应使用子路径（客户端清单扫描不到）');
    assert(!patch.includes('dsh-tool-subagent-control/list-agents'), '0.2.2 已并入主包，不应保留 list-agents 子路径');
    const workflow = await readFile(path.join(repoRoot, '.github', 'workflows', 'verify.yml'), 'utf8');
    assert(workflow.includes('npm pack --dry-run --json'), 'CI 必须执行发布包内容清单检查');
    assert(workflow.includes('DSH ≥ 0.2.2-rc.2'), 'CI 兼容路线说明应匹配侧栏面板最低版本');
  });

  await check('Client 源码可解析并注册左侧创作工作台面板', async () => {
    const clientFile = path.join(repoRoot, 'plugins', 'workbench', 'client.js');
    execFileSync(process.execPath, ['--check', clientFile], { stdio: 'pipe' });
    const source = await readFile(clientFile, 'utf8');
    assert(source.includes("id: 'dsh-creator'"), 'Client 模块 id 应为包名 dsh-creator');
    assert(source.includes("'sidebar.panellist'"), '左侧全局面板列表未注册创作工作台入口');
    assert(source.includes("name: 'main'"), '未注册创作工作台主面板');
    assert(source.includes('key: PANEL_ID'), '侧栏入口与工作台主面板应共享稳定 ID');
    assert(source.includes('useSessions((state) => state)'), '主面板应从会话列表选择工作区');
    assert(source.includes('retainedBy.mainView'), '初次打开应优先沿用当前会话');
    assert(!source.includes("ctx.slots.inject('conversation.view'"), '工作台不应再重复占用会话头部视图页签');
    assert(source.includes('/creator-workbench/v1/api'), 'Client 未连接工作台路由');
    assert(source.includes('sessionId: selected.id'), '所选会话 ID 未传入工作台');
    assert(source.includes('dsh-creator:draft'), '缺少浏览器崩溃恢复草稿缓存');
    assert(source.includes('检测到') && source.includes('未保存草稿'), '缺少草稿恢复确认');
    assert(source.includes("api('history'") && source.includes("api('restore'"), '缺少历史版本接口调用');
    assert(source.includes('导出全本'), '缺少整本导出入口');
    assert(!source.includes('dsh-novel-editor'), 'Client 仍引用旧独立编辑器');
  });

  await check('Client 2.4：全书体检入口、游标循环与停止', async () => {
    const source = await readFile(path.join(repoRoot, 'plugins', 'workbench', 'client.js'), 'utf8');
    assert(source.includes("api('scan'"), '缺少全书体检接口调用');
    assert(/while \((offset !== null && offset !== undefined && scanRef\.current)\)/.test(source), '体检循环必须以 next 游标与 scanRef 为条件');
    assert(source.includes('setScanRows((rows) => [...rows, ...data.chapters])'), '每批结果应合并渲染（不是最后一次性替换）');
    assert(source.includes('const stopScan = '), '缺少停止体检入口');
    assert(source.includes('继续体检'), '应支持接着上次进度继续');
    assert(source.includes('正文/${row.file}'), '体检条目应能直达对应章节');
    assert(source.includes('全书体检'), '缺少「全书体检」入口');
  });

  await check('Client 2.4：TXT 纯文本导出与前后端转换一致', async () => {
    const source = await readFile(path.join(repoRoot, 'plugins', 'workbench', 'client.js'), 'utf8');
    assert(source.includes('导出 TXT'), '缺少「导出 TXT」按钮');
    assert(source.includes('.txt'), 'TXT 导出应下载 .txt 文件');
    assert(source.includes('text/plain'), 'TXT 导出应使用 text/plain');
    // 与 hashText 同样的约定：前后端各有一份实现，测试锚定两者输出一致
    const match = source.match(/function toPlainText\(markdown\) \{([\s\S]*?)\n    \}\n/);
    assert(match, 'Client 缺少 toPlainText 实现');
    const clientPlain = new Function('markdown', `return (${match[0].replace('function toPlainText(markdown) {', 'function(markdown){').replace(/\}\n$/, '}')})(markdown)`);
    for (const sample of [
      '# 第001章-雪夜\n\n**风灌进屋里**。\n',
      '> 他想起[[林远|阿远]]。\n\n| 时间 | 事件 |\n| --- | --- |\n| 第一夜 | 抵达 |\n',
      '- 甲\n- 乙\n\n---\n\n[手册](https://example.com) 与 `代码`。',
      '',
    ]) {
      assert(clientPlain(sample) === toPlainText(sample), `前后端纯文本转换不一致：${JSON.stringify(String(clientPlain(sample)).slice(0, 60))}`);
    }
    // 共享读取循环：Markdown 与 TXT 导出复用同一份容错逻辑
    assert(source.includes('const readAllChapters = '), '缺少共享的逐章读取循环');
    assert(!source.includes('api(\'export-plain\''), 'TXT 转换在前端本地完成，不应有 export-plain 路由调用');
  });

  await check('Client 2.4：写作活动统计入口与空态', async () => {
    const source = await readFile(path.join(repoRoot, 'plugins', 'workbench', 'client.js'), 'utf8');
    assert(source.includes("api('activity'"), '缺少写作活动接口调用');
    assert(source.includes('最近写作活动'), '总览缺少「最近写作活动」区块');
    assert(source.includes('连续 '), '活动区应显示连续写作天数');
    assert(source.includes('还没有保存记录'), '活动区缺少优雅空态文案');
    assert(source.includes('cw-activity-bars'), '缺少活动条形图样式');
    assert(source.includes('maxAdded'), '条形图应有高度基准');
  });

  await check('Client 2.5：双链解析与一键建档', async () => {
    const resolveWikiLink = await clientFunction('resolveWikiLink');
    const wikiSkeleton = await clientFunction('wikiSkeleton');
    // 带目录前缀的双链（整理索引生成的形态）直接按目录约定解析
    assert(resolveWikiLink('人物卡/林远', null) === '人物卡/林远.md', '带目录双链应解析为对应档案');
    assert(resolveWikiLink('设定集/力量体系', null) === '设定集/力量体系.md', '设定集双链解析不正确');
    // 追踪文件别名
    assert(resolveWikiLink('伏笔清单', null) === '伏笔清单.md', '伏笔清单双链应解析为追踪文件');
    assert(resolveWikiLink('作品索引', null) === 'README.md', '作品索引别名应解析为 README');
    // 章节与树内文件需要 stats
    const stats = {
      chapters: [{ file: '第001章-雪夜.md', num: 1 }],
      tree: { 人物卡: ['林远.md'], 设定集: ['力量体系.md'], 大纲: ['总纲.md'], 归档: [] },
      special: { readme: true, foreshadow: true },
    };
    assert(resolveWikiLink('第001章-雪夜', stats) === '正文/第001章-雪夜.md', '章节双链应按 stats 解析');
    assert(resolveWikiLink('林远', stats) === '人物卡/林远.md', '人物双链应按 stats 树解析');
    assert(resolveWikiLink('总纲', stats) === '大纲/总纲.md', '大纲双链应按 stats 树解析');
    // 未建档返回 null（走一键建档），非法目标也返回 null
    assert(resolveWikiLink('无名新人', stats) === null, '未建档名词应返回 null 而不是猜路径');
    assert(resolveWikiLink('.hidden', stats) === null, '点开头段应拒绝');
    assert(resolveWikiLink('', stats) === null, '空目标应返回 null');
    // 一键建档骨架：人物卡与设定集有结构化模板
    assert(wikiSkeleton('人物卡', '林远').includes('# 林远') && wikiSkeleton('人物卡', '林远').includes('身份'), '人物卡骨架缺少基本字段');
    assert(wikiSkeleton('设定集', '炼丹术').includes('关联设定'), '设定集骨架应带关联双链');
    // Client 接线：双链可点击、目标打开、未建档走确认建档
    const source = await readFile(path.join(repoRoot, 'plugins', 'workbench', 'client.js'), 'utf8');
    assert(/className: 'cw-wikilink'[\s\S]{0,220}onClick: \(\) => openWikiLink\(target\)/.test(source), '双链 span 应挂 onClick 跳转');
    assert(source.includes('const openWikiLink = '), '缺少双链跳转处理器');
    assert(source.includes('还没有对应档案'), '未建档应有确认提示');
    assert(source.includes("api('save', { path: resolved, content: body"), '一键建档应走工作台保存通道');
    assert(source.includes('onOpenLink: openWikiLink'), '阅读视图应把跳转处理器传给文档渲染');
    assert(source.includes('cw-wikilink:hover'), '双链应有可点击的悬停反馈');
  });

  await check('Client 2.5：写作目标与进度推算', async () => {
    const source = await readFile(path.join(repoRoot, 'plugins', 'workbench', 'client.js'), 'utf8');
    assert(source.includes('api(\'goal\''), '缺少目标写入接口调用');
    assert(source.includes('goalPercent') && source.includes('estimateFinish'), '缺少进度与预计完成日推算函数');
    assert(source.includes('写作目标'), '总览缺少「写作目标」区块');
    assert(source.includes('预计完成'), '应按当前速度推算预计完成日');
    assert(source.includes('cw-goal-bar') && source.includes('cw-goal-fill'), '缺少进度条样式');
    assert(/清除/.test(source), '目标应可清除');
    // 前端推算函数单测（与内核无关，但锁定口径：百分比收敛、速度为零不给预计日）
    const extract = (name) => {
      const start = source.indexOf(`function ${name}(`);
      assert(start >= 0, `Client 缺少 ${name}`);
      let depth = 0;
      let i = source.indexOf('{', start);
      for (; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') { depth -= 1; if (depth === 0) break; }
      }
      return new Function(`${source.slice(start, i + 1)}; return ${name};`)();
    };
    const percent = extract('goalPercent');
    const eta = extract('estimateFinish');
    assert(percent(400000, 800000) === 50, '进度百分比计算不正确');
    assert(percent(900000, 800000) === 100, '超目标应收敛到 100');
    assert(percent(100, 0) === 0, '无目标应返回 0');
    const day = eta(300000, 800000, 70000, 14, new Date(2026, 0, 1).getTime());
    // 剩余 50 万字，速度 5000 字/天 → 100 天 → 2026-04-11
    assert(day === '2026-04-11', `预计完成日推算不正确：${day}`);
    assert(eta(800000, 800000, 70000, 14) === null, '已达目标不应给预计日');
    assert(eta(300000, 800000, 0, 14) === null, '速度为零不应给预计日');
  });

  await check('Client 2.5：伏笔清单快捷视图与行定位', async () => {
    const source = await readFile(path.join(repoRoot, 'plugins', 'workbench', 'client.js'), 'utf8');
    assert(source.includes('renderForeshadowQuick'), '总览缺少伏笔快捷视图渲染函数');
    assert(source.includes('未回收伏笔'), '总览缺少「未回收伏笔」区块标题');
    assert(source.includes("openFile(path, { line: item.line })"), '点击伏笔条目应带行号直达清单');
    // 阅读器支持行定位：openFile 接收 line，NovelDoc 渲染高亮行
    assert(/Number\(options && options\.line\)/.test(source), 'openFile 应解析 options.line 行定位参数');
    assert(source.includes('cw-table-row-focus'), '缺少定位行高亮样式');
    assert(/table\.map\(\(row\) => h\('div', \{/.test(source), '定位模式下表格应逐行渲染');
    assert(source.includes('.cw-foreshadow-item'), '缺少伏笔条目样式');
  });

  await check('Client 2.6：历史快照对比面板与降级渲染', async () => {
    const source = await readFile(path.join(repoRoot, 'plugins', 'workbench', 'client.js'), 'utf8');
    // 面板入口：历史行加「对比」，按需加载（打开面板不自动全量拉 diff）
    assert(source.includes("api('diff'"), '缺少快照对比接口调用');
    assert(source.includes('const diffSnapshot = '), '缺少快照对比处理器');
    assert(source.includes('onClick: () => diffSnapshot(snap)'), '历史行应挂「对比」按钮');
    assert(/setDiffData\(null\);\s*\n\s*setHistoryLoading\(true\)/.test(source), '打开历史面板应清空上一次的 diff 数据');
    // 统计与逐行渲染：增/删/改三色 + skip 折叠 + 降级说明
    assert(source.includes('cw-diff-rows'), '缺少 diff 逐行渲染容器');
    assert(source.includes('cw-diff-skip'), '缺少未变行折叠标记样式');
    assert(source.includes('diffRowTone'), '缺少 diff 行符号/配色映射');
    assert(/diffData\.truncated[\s\S]{0,400}降级为仅统计/.test(source), '超限降级应展示统计模式说明');
    assert(source.includes('当前文件已不存在'), '文件被删除时应说明快照与空内容的差异口径');
    assert(source.includes('快照与当前内容一致'), '零差异应有明确文案');
  });

  await check('Client 2.6：反链面板按需加载与引用直达', async () => {
    const source = await readFile(path.join(repoRoot, 'plugins', 'workbench', 'client.js'), 'utf8');
    assert(source.includes("api('backlinks'"), '缺少反链接口调用');
    assert(source.includes('const loadBacklinks = '), '缺少反链加载处理器');
    // 按需加载：不随渲染自动全量读文件，换文件清缓存 + 手动刷新按钮
    assert(/onClick: \(\) => loadBacklinks\(\)/.test(source), '反链区块应有「刷新」按钮');
    assert(/setBacklinks\(null\);/.test(source), '切换文件/回总览应清空反链缓存');
    assert(source.includes('cw-backlink-list'), '缺少反链列表样式');
    // 点击引用条目带行号直达引用处
    assert(/onClick: \(\) => openFile\(ref\.path, \{ line: ref\.line \}\)/.test(source), '反链条目应带行号直达引用处');
    assert(source.includes('没有引用') && source.includes('还没有其他文件用 [[双链]] 引用'), '空态应有明确文案');
  });

  await check('Client 2.6：章节内查找定位与循环步进', async () => {
    const source = await readFile(path.join(repoRoot, 'plugins', 'workbench', 'client.js'), 'utf8');
    // 纯函数单测：命中 span 与循环步进（与 goalPercent/estimateFinish 同一套源码提取）
    const extract = (name) => {
      const start = source.indexOf(`function ${name}(`);
      assert(start >= 0, `Client 缺少 ${name}`);
      let depth = 0;
      let i = source.indexOf('{', start);
      for (; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') { depth -= 1; if (depth === 0) break; }
      }
      return new Function(`${source.slice(start, i + 1)}; return ${name};`)();
    };
    const spans = extract('findMatchSpans');
    const step = extract('stepMatch');
    // 命中：多命中、行号、大小写不敏感、空关键词空集、上限保护
    const text = '第一行有铜钥匙。\n第二行没有。\n第三行又见铜钥匙与铜锁。';
    const hits = spans(text, '铜钥匙');
    assert(hits.length === 2, `应命中 2 处，实际 ${hits.length}`);
    assert(hits[0].line === 1 && hits[1].line === 3, '命中应带 1 起行号');
    assert(text.slice(hits[0].start, hits[0].end) === '铜钥匙', 'span 应可反取原文');
    assert(spans('ABC abc', 'abc').length === 2, '查找应不区分大小写');
    assert(spans(text, '').length === 0, '空关键词返回空集');
    assert(spans('', '铜钥匙').length === 0, '空文本返回空集');
    assert(spans('甲甲甲', '甲甲').length === 1, '重叠命中应跳过已匹配段');
    assert(spans(`x${'甲'.repeat(6000)}`, '甲').length <= 5000, '命中数应有上限保护');
    // 步进：循环环绕、空集回 -1、首次定位
    assert(step(-1, 3, 1) === 0, '未定位时下一个应从第 1 处开始');
    assert(step(-1, 3, -1) === 2, '未定位时上一个应从最后 1 处开始');
    assert(step(0, 3, -1) === 2, '第 1 处往上应环绕到最后');
    assert(step(2, 3, 1) === 0, '最后 1 处往下应环绕到第 1 处');
    assert(step(1, 3, 1) === 2 && step(1, 3, -1) === 0, '中间步进应为相邻序号');
    assert(step(0, 0, 1) === -1, '无命中应返回 -1');
    // 接线：Ctrl+F 唤起 / Esc 关闭 / Enter 与 Shift+Enter 步进 / 计数显示 / textarea selection
    assert(/key === 'f' || event\.key === 'F'/.test(source), 'Ctrl+F 应唤起查找条');
    assert(/event\.key === 'Escape' && findOpen/.test(source), 'Esc 应关闭查找条');
    assert(/stepFind\(ev\.shiftKey \? -1 : 1\)/.test(source), 'Enter/Shift+Enter 应分别步进下/上一个');
    assert(source.includes('setSelectionRange(span.start, span.end)'), '编辑态应操作 textarea selection');
    assert(/active\.scrollTop = Math\.max\(0, line \* perLine/.test(source), '编辑态应滚动到命中行附近');
    assert(source.includes('cw-findbar') && source.includes('cw-find-count'), '缺少查找条与命中计数样式');
    assert(source.includes('无命中'), '零命中应有明确计数文案');
    assert(source.includes('const closeFind = '), '缺少查找条关闭处理器');
    assert(source.includes("onClick: () => setFindOpen(true)"), '顶栏应有「查找」按钮入口');
  });

  await check('Host 源码可解析', async () => {
    execFileSync(process.execPath, ['--check', path.join(repoRoot, 'plugins', 'workbench', 'index.js')], { stdio: 'pipe' });
  });

  console.log(`\n${failures.length ? 'FAIL' : 'PASS'} — ${pass} 项通过，${failures.length} 项失败`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
