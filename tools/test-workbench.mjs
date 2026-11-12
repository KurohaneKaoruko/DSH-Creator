#!/usr/bin/env node
// 创作工作台测试（不依赖 dsh 内核）
// -----------------------------------------------------------------------------
// 工作台是 2.1 的主体：Host 路由必须能在「只有 fs + sessions 的宿主」里安全地
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
//   6. 包结构：工作台已并入主包（无独立 plugins-dsh 编辑器）、exports/dsh.client 完整；
//   7. Client 源码语法可解析且注册在 conversation.view。
//
// 跑法：node test-workbench.mjs

import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import url from 'node:url';

import { apply, API_PREFIX } from '../plugins/workbench/index.js';
import { parseChapterFile, chapterFile, countChars, auditForeshadow, PROJECT } from '../plugins/project-core.mjs';

const repoRoot = path.resolve(url.fileURLToPath(new URL('..', import.meta.url)));

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
    async writeText(target, text) { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, text, 'utf8'); },
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
  const ctx = {
    get(name) {
      if (name === 'fs') return makeFs();
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
  return { ctx, routes, listeners, dispose, webServer };
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
    });

    await check('index 重建 README 并带章节双链', async () => {
      const data = await callOk(route, 'index', { sessionId: 's1', title: '长夜将至' });
      assert(data.summary.includes('1 章'), `索引摘要不正确：${data.summary}`);
      const readme = await readFile(path.join(root, PROJECT.readme), 'utf8');
      assert(readme.includes('[[第001章-雪夜]]'), 'README 缺少章节双链');
      assert(readme.includes('[[伏笔清单]]'), 'README 缺少追踪文件链接');
    });

    await check('工程内核：章节文件名与解析互逆', async () => {
      assert(chapterFile(7, '雨夜') === '正文/第007章-雨夜.md', 'chapterFile 输出不正确');
      const parsed = parseChapterFile('第007章-雨夜.md');
      assert(parsed && parsed.num === 7 && parsed.title === '雨夜', 'parseChapterFile 解析不正确');
      assert(parseChapterFile('说明.md') === null, '说明.md 不应被当作章节');
    });

    await check('工程内核：字数口径与伏笔体检', async () => {
      assert(countChars('你好 world') === 3, '中英文字数口径不正确');
      const audit = auditForeshadow('| 伏笔 | 铺设位置 | 状态 |\n| --- | --- | --- |\n| 旧信 | 第1章 | 未回收 |\n', 30);
      assert(audit.total === 1 && audit.openCount === 1 && audit.stale.length === 1, '伏笔体检结果不正确');
    });

    h.dispose();
  } finally {
    await rm(base, { recursive: true, force: true });
  }

  await check('编辑器已并入主包，不再有独立 bundle', async () => {
    assert(await absent(path.join(repoRoot, 'plugins-dsh')), 'plugins-dsh 仍存在');
    await access(path.join(repoRoot, 'plugins', 'workbench', 'client.js'));
    await access(path.join(repoRoot, 'plugins', 'workbench', 'index.js'));
    assert(await absent(path.join(repoRoot, 'agent.cordis.yml')), 'agent.cordis.yml 旧安装路线仍存在');
  });

  await check('package.json：dsh.client 与 exports 指向工作台', async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
    assert(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web', '缺少 dsh.client.platform=web');
    assert(pkg.dsh.client.immediately === true, '工作台应随 bootstrap 立即注册');
    assert(pkg.exports['./client'] === './plugins/workbench/client.js', 'exports ./client 未指向工作台');
    assert(pkg.exports['.'] === './plugins/workbench/index.js', '包根未指向工作台 Host');
    assert(pkg.files.includes('skills'), '发布包未包含 skills');
    assert(pkg.dsh.bundle.patch === './cordis.patch.yml', 'bundle patch 声明不正确');
    const patch = await readFile(path.join(repoRoot, 'cordis.patch.yml'), 'utf8');
    assert(/name:\s*'dsh-creator'\s*$/m.test(patch), '工作台负载行必须使用包根名（客户端发现依赖包根）');
    assert(!patch.includes('dsh-creator/plugins/workbench/index.js'), '工作台负载行不应使用子路径（客户端清单扫描不到）');
    assert(!patch.includes('dsh-tool-subagent-control/list-agents'), '0.2.2 已并入主包，不应保留 list-agents 子路径');
  });

  await check('Client 源码可解析并注册 conversation.view', async () => {
    const clientFile = path.join(repoRoot, 'plugins', 'workbench', 'client.js');
    execFileSync(process.execPath, ['--check', clientFile], { stdio: 'pipe' });
    const source = await readFile(clientFile, 'utf8');
    assert(source.includes("id: 'dsh-creator'"), 'Client 模块 id 应为包名 dsh-creator');
    assert(source.includes("'conversation.view'"), '未注册 conversation.view');
    assert(source.includes('/creator-workbench/v1/api'), 'Client 未连接工作台路由');
    assert(source.includes('props.sessionId'), '未从视图槽 props 取得会话 ID（助手切换需要）');
    assert(!source.includes('dsh-novel-editor'), 'Client 仍引用旧独立编辑器');
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
