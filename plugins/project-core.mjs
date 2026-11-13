// 作品工程内核（工具层与工作台共用）
// -----------------------------------------------------------------------------
// 这里是「作品工程」的唯一实现：目录约定、章节文件名、初始化骨架、保存章节、
// 进度统计、索引重建、伏笔体检。
//
// 为什么单独拆出来：
//   1. creator_* 工具（Agent 侧）与创作工作台（Web 侧）必须读写同一套文件约定，
//      两份实现迟早会漂移；
//   2. 工作台要能在没有任何模型调用的情况下完成「新建工程 / 新建章节 / 统计 /
//      整理索引」，这些能力和工具用的是同一段代码；
//   3. tools/test-workbench.mjs 可以绕开工具装配，直接对工程内核做单元测试。
//
// 零外部依赖：只用 Node 内建能力与传入的 fs 服务（与 Agent 的 write 工具同一
// 通道，保留工作区边界）。所有路径都是相对工作区根的 POSIX 风格相对路径。
// 唯一的内部依赖是 lint.mjs（正文检查引擎，同为纯函数模块）：全书体检 scanBook
// 逐章调用它，保证工作台、creator_lint、保存门禁三处检查口径完全一致。

import { lintText } from './lint.mjs';

/** 伏笔悬空阈值：铺设超过这么多章仍未回收，写前材料里单独点名提醒 */
export const STALE_CHAPTERS = 15;

/** 单章默认篇幅区间（与助手人设的「单章默认标准」一致） */
export const CHAPTER_MIN = 2000;
export const CHAPTER_MAX = 4000;

/** 工程目录约定（工作台导航、工具、文档共用一份） */
export const PROJECT = {
  chapters: '正文',
  outline: '大纲',
  settings: '设定集',
  characters: '人物卡',
  archive: '归档',
  readme: 'README.md',
  foreshadow: '伏笔清单.md',
  timeline: '时间线.md',
  styleCard: '文风卡.md',
};

/** 脚手架文件：初始化工程时写入的完整清单 */
export const SCAFFOLD_FILES = [
  PROJECT.readme,
  PROJECT.foreshadow,
  PROJECT.timeline,
  `${PROJECT.outline}/总纲.md`,
  `${PROJECT.settings}/_索引.md`,
  `${PROJECT.settings}/世界观.md`,
  `${PROJECT.settings}/力量体系.md`,
  `${PROJECT.settings}/地理.md`,
  `${PROJECT.settings}/势力.md`,
  `${PROJECT.characters}/_索引.md`,
  `${PROJECT.archive}/说明.md`,
  `${PROJECT.chapters}/说明.md`,
  PROJECT.styleCard,
];

/** 章节文件名里的标题需要去掉文件系统不安全字符 */
export function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|\r\n]/g, '').trim();
}

/** 章号统一补零到三位：第001章 */
export function padChapter(num) {
  return String(num).padStart(3, '0');
}

/** 章节文件名：正文/第001章-标题.md；标题缺省或清洗后为空时省略短横线 */
export function chapterFile(num, title) {
  const clean = safeName(title);
  const suffix = clean ? `-${clean}` : '';
  return `${PROJECT.chapters}/第${padChapter(num)}章${suffix}.md`;
}

/** 解析章节文件名 → { num, title, file }；不是章节文件返回 null */
export function parseChapterFile(file) {
  const m = String(file).match(/^第(\d+)章(?:-(.*))?\.md$/);
  if (!m) return null;
  return { num: parseInt(m[1], 10), title: (m[2] || '').trim(), file };
}

/**
 * 伏笔体检：从伏笔清单表格算出「未回收条目距本章已过多少章」，把长期悬空的
 * 条目挑出来。章数是确定性的算术，交给代码算比让模型逐行数表格可靠。
 * 返回 { total, openCount, stale[], open[] }；表格不可解析时返回 null。
 * open[] 是全部未回收条目（含所在表格行号，1 起，对应清单文件里的物理行），
 * 供总览「伏笔快捷视图」点击直达；stale 只挑长期悬空的，量少语义更重。
 * @param {string} table 伏笔清单 Markdown 表格
 * @param {number} currentNum 当前章号
 */
export function auditForeshadow(table, currentNum) {
  const allLines = String(table || '').split('\n');
  const rows = [];
  allLines.forEach((l, physical) => {
    if (l.trim().startsWith('|')) rows.push({ text: l, line: physical + 1 });
  });
  if (rows.length < 2) return null;
  const cellsOf = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const header = cellsOf(rows[0].text);
  const idx = { name: 0, laid: 1, status: Math.max(0, header.length - 1) };
  header.forEach((h, i) => {
    if (/伏笔|名称|条目/.test(h)) idx.name = i;
    else if (/铺设|埋设|起始/.test(h)) idx.laid = i;
    else if (/状态/.test(h)) idx.status = i;
  });
  const items = [];
  rows.forEach((row, i) => {
    if (i === 0) return;
    const cells = cellsOf(row.text);
    // 跳过 | --- | --- | 分隔行
    if (cells.every((c) => c === '' || /^:?-{2,}:?$/.test(c))) return;
    const name = cells[idx.name] || '';
    if (!name || name === '伏笔') return;
    const status = cells[idx.status] || '';
    const open = !/已回收|已收|已填|已兑现|已完成/.test(status);
    const m = (cells[idx.laid] || '').match(/第\s*(\d+)\s*章/);
    const laidAt = m ? parseInt(m[1], 10) : null;
    const gap = laidAt !== null && currentNum ? currentNum - laidAt : null;
    items.push({ name, status, laidAt, gap, open, line: row.line });
  });
  if (!items.length) return null;
  const openItems = items.filter((i) => i.open);
  const stale = openItems
    .filter((i) => i.gap !== null && i.gap >= STALE_CHAPTERS)
    .sort((a, b) => b.gap - a.gap);
  return { total: items.length, openCount: openItems.length, stale, open: openItems };
}

/** 字数：CJK 字符 + 英文单词，与工作台显示口径一致 */
export function countChars(text) {
  const cjk = (String(text || '').match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const latin = (String(text || '').match(/[a-zA-Z]+/g) || []).length;
  return cjk + latin;
}

/**
 * 正文内容指纹（FNV-1a 32 位）。工作台在打开文件时记下它，保存时带回；
 * Host 先比对当前落盘文本，再叠加 fs 的版本守卫，防止 Agent 或另一个窗口
 * 在编辑期间改动文件后被静默覆盖。客户端与内核共用同一实现。
 */
export function hashText(text) {
  let hash = 0x811c9dc5;
  const source = String(text || '');
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 工作台自动快照目录（相对工程根，不参与正文/索引/检索） */
export const HISTORY_DIR = '.history';

/** 历史快照文件名的合法形态：YYYYMMDD-HHMMSS-xxxx.md */
export const SNAPSHOT_NAME_RE = /^\d{8}-\d{6}-[a-z0-9]{4}\.md$/;

/** 一个文件的历史快照目录：.history/正文/第001章-雪夜/ */
export function historyFolder(rel) {
  return `${HISTORY_DIR}/${String(rel || '').replace(/\.md$/i, '')}`;
}

/** 生成一个可按时间排序、带随机后缀的快照名 */
export function snapshotName(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `${stamp}-${suffix}.md`;
}

// ---------------- 历史快照 diff（恢复前先看清差在哪） ----------------

/**
 * 行级 diff（自写 LCS 动态规划，零依赖纯函数）：对比历史快照与当前文本。
 * 方向约定：oldText = 快照，newText = 当前；added 是「当前比快照多出的行」。
 * 返回 { truncated, stats, rows }：
 *   - stats：{ oldLines, newLines, added, removed, changed, unchanged }；
 *   - rows：逐行差异（前端 ±着色渲染）。「改」= 相邻的一段删行与加行按顺序
 *     两两配对（行数取小者）；未变行只保留变更点前后 context 行，中间以
 *     {type:'skip', count} 标记，面板不必渲染整章；
 *   - 长章节性能保护：任一侧超过 maxLines（默认 800）行时不再做 LCS，降级为
 *     多重集合近似统计（把「改」计成一对增删，added/removed 仍可靠），rows
 *     返回 null，前端只展示统计。
 * @param {string} oldText 快照文本
 * @param {string} newText 当前文本
 * @param {{maxLines?:number,context?:number}} [options]
 */
export function diffLines(oldText, newText, options = {}) {
  // 空文本归一为零行（''.split('\n') 会得到一个空行，把「清空文件」错算成改写）
  const a = String(oldText || '') === '' ? [] : String(oldText || '').split('\n');
  const b = String(newText || '') === '' ? [] : String(newText || '').split('\n');
  const maxLines = options.maxLines === undefined || options.maxLines === null
    ? 800
    : Math.max(50, Number(options.maxLines) || 50);
  const context = Math.min(Math.max(options.context === undefined ? 2 : Number(options.context), 0), 20);
  if (a.length > maxLines || b.length > maxLines) {
    // 降级：多重集合交集中计数，不做逐行对齐
    const counter = (lines) => {
      const map = new Map();
      for (const l of lines) map.set(l, (map.get(l) || 0) + 1);
      return map;
    };
    const ca = counter(a);
    const cb = counter(b);
    let common = 0;
    for (const [line, n] of ca) common += Math.min(n, cb.get(line) || 0);
    return {
      truncated: true,
      stats: {
        oldLines: a.length,
        newLines: b.length,
        added: Math.max(0, b.length - common),
        removed: Math.max(0, a.length - common),
        changed: 0,
        unchanged: common,
      },
      rows: null,
    };
  }
  const m = a.length;
  const n = b.length;
  // 后缀式 LCS 长度表：table[i][j] = LCS(a[i..], b[j..])
  const table = new Int32Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      table[i * (n + 1) + j] = a[i] === b[j]
        ? table[(i + 1) * (n + 1) + j + 1] + 1
        : Math.max(table[(i + 1) * (n + 1) + j], table[i * (n + 1) + j + 1]);
    }
  }
  // 回溯出 op 序列：'=' 同 / '-' 快照删 / '+' 当前增
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ t: '=', text: a[i], old: i + 1, new: j + 1 });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * (n + 1) + j] >= table[i * (n + 1) + j + 1]) {
      ops.push({ t: '-', text: a[i], old: i + 1 });
      i += 1;
    } else {
      ops.push({ t: '+', text: b[j], new: j + 1 });
      j += 1;
    }
  }
  while (i < m) { ops.push({ t: '-', text: a[i], old: i + 1 }); i += 1; }
  while (j < n) { ops.push({ t: '+', text: b[j], new: j + 1 }); j += 1; }
  // 相邻「删段 + 加段」按顺序两两配对成「改」
  const stats = { oldLines: m, newLines: n, added: 0, removed: 0, changed: 0, unchanged: 0 };
  const rows = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === '-') {
      let del = 0;
      while (k + del < ops.length && ops[k + del].t === '-') del += 1;
      let add = 0;
      while (k + del + add < ops.length && ops[k + del + add].t === '+') add += 1;
      const pair = Math.min(del, add);
      for (let p = 0; p < pair; p += 1) {
        rows.push({
          type: 'mod',
          text: ops[k + del + p].text,
          oldText: ops[k + p].text,
          old: ops[k + p].old,
          new: ops[k + del + p].new,
        });
        stats.changed += 1;
      }
      for (let p = pair; p < del; p += 1) { rows.push({ type: 'del', text: ops[k + p].text, old: ops[k + p].old }); stats.removed += 1; }
      for (let p = pair; p < add; p += 1) { rows.push({ type: 'add', text: ops[k + del + p].text, new: ops[k + del + p].new }); stats.added += 1; }
      k += del + add;
      continue;
    }
    if (ops[k].t === '+') { rows.push({ type: 'add', text: ops[k].text, new: ops[k].new }); stats.added += 1; k += 1; continue; }
    rows.push({ type: 'same', text: ops[k].text, old: ops[k].old, new: ops[k].new });
    stats.unchanged += 1;
    k += 1;
  }
  // 上下文压缩：未变行只保留变更点前后 context 行，其余折叠成 skip 标记。
  // 完全零差异时直接返回空 rows——前端据此显示「快照与当前内容一致」，
  // 不必把整章未变行逐行搬给浏览器。
  if (!stats.added && !stats.removed && !stats.changed) {
    return { truncated: false, stats, rows: [] };
  }
  const keep = new Array(rows.length).fill(false);
  rows.forEach((row, idx) => {
    if (row.type === 'same') return;
    for (let d = -context; d <= context; d += 1) {
      const at = idx + d;
      if (at >= 0 && at < rows.length) keep[at] = true;
    }
  });
  const compact = [];
  let run = 0;
  const flushRun = () => {
    if (run > 0) compact.push({ type: 'skip', count: run });
    run = 0;
  };
  rows.forEach((row, idx) => {
    if (row.type === 'same' && !keep[idx]) { run += 1; return; }
    flushRun();
    compact.push(row);
  });
  flushRun();
  return { truncated: false, stats, rows: compact };
}

/**
 * 打开作品工程：读取（缺文件容错）、列 Markdown、写入、章节定位。
 * 工程目录约定：正文/、大纲/、设定集/、人物卡/、归档/、伏笔清单.md、时间线.md。
 * 各目录下由初始化生成的 说明.md 是脚手架，列目录时跳过。
 * @param {any} fs 组合文件系统服务
 * @param {string} root 工作区根
 * @param {any} policy 沙箱执行策略（可为 undefined）
 */
export function openProject(fs, root, policy) {
  const readMaybe = async (rel, cap) => {
    try {
      const target = await fs.resolve(rel, { cwd: root });
      let text = await fs.readText(target);
      if (cap && text.length > cap) text = `${text.slice(0, cap)}\n…（已截断）`;
      return text;
    } catch (err) { return null; }
  };

  const listMd = async (dir) => {
    try {
      const target = await fs.resolve(dir, { cwd: root });
      const entries = await fs.listDir(target);
      return entries
        .filter((e) => e.type === 'file' && /\.md$/.test(e.name) && e.name !== '说明.md')
        .map((e) => e.name).sort();
    } catch (err) { return []; }
  };

  const writeGuarded = async (rel, text, expected) => {
    const target = await fs.resolve(rel, { cwd: root });
    const outcome = await fs.writeText(target, text, expected, undefined, policy);
    return {
      rel,
      operation: outcome && outcome.operation,
      version: outcome && outcome.version,
    };
  };

  const write = async (rel, text) => (await writeGuarded(rel, text, undefined)).rel;

  // 章节文件按「第NNN章」序号排序；number 给定时只取序号小于它的章节
  const chapters = async (number) => {
    const names = await listMd(PROJECT.chapters);
    return names
      .map(parseChapterFile)
      .filter((c) => c !== null && (number === undefined || number === null || c.num < number))
      .sort((a, b) => a.num - b.num);
  };

  const latestChapter = async (number) => {
    const list = await chapters(number);
    if (!list.length) return null;
    return list[list.length - 1].file;
  };

  const chapterTail = async (number, chars) => {
    const name = await latestChapter(number);
    if (!name) return null;
    const text = await readMaybe(`${PROJECT.chapters}/${name}`);
    if (!text) return null;
    return { name, tail: text.length > chars ? text.slice(-chars) : text };
  };

  // 取指定章之前 count 章的结尾（按章号升序返回），用于多章前文参考
  const recentChapterTails = async (number, count, tailChars) => {
    const list = await chapters(number);
    const picked = list.slice(-Math.max(1, count));
    const outList = [];
    for (const p of picked) {
      const text = await readMaybe(`${PROJECT.chapters}/${p.file}`);
      if (!text) continue;
      outList.push({ name: p.file, num: p.num, tail: text.length > tailChars ? text.slice(-tailChars) : text });
    }
    return outList;
  };

  // 保留最近 40 个快照，避免长期写作把 .history 撑爆；删除失败不影响保存
  const pruneSnapshots = async (rel) => {
    if (typeof fs.deleteFile !== 'function') return;
    const list = await listSnapshots(rel);
    for (const old of list.slice(40)) {
      try {
        const target = await fs.resolve(old.path, { cwd: root });
        await fs.deleteFile(target, undefined, undefined, policy);
      } catch (err) { /* 清理失败不阻断 */ }
    }
  };

  // 手工保存前把磁盘旧文本存成快照，供「历史版本」列表与回滚使用。
  // 只有客户端显式要求（history:true）才做；自动保存不制造快照，避免刷屏。
  const snapshot = async (rel, text) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const name = snapshotName();
      const path = `${historyFolder(rel)}/${name}`;
      try {
        await writeGuarded(path, text, { kind: 'createIfAbsent' });
        await pruneSnapshots(rel);
        return { name, path };
      } catch (err) {
        if (err && err.code === 'FS_NOT_OBSERVED') continue;
        throw err;
      }
    }
    throw new Error('无法生成唯一的历史快照名');
  };

  const listSnapshots = async (rel) => {
    const folder = historyFolder(rel);
    try {
      const target = await fs.resolve(folder, { cwd: root });
      if (typeof fs.stat === 'function') {
        const info = await fs.stat(target);
        if (!info || info.type !== 'directory') return [];
      }
      const entries = await fs.listDir(target);
      return entries
        .filter((entry) => entry && entry.type === 'file' && SNAPSHOT_NAME_RE.test(entry.name))
        .map((entry) => ({ name: entry.name, path: `${folder}/${entry.name}`, size: entry.size || 0 }))
        .sort((a, b) => b.name.localeCompare(a.name));
    } catch (err) {
      return [];
    }
  };

  const readSnapshot = async (rel, name) => {
    if (!SNAPSHOT_NAME_RE.test(String(name || ''))) {
      const err = new Error('历史快照名不合法');
      err.code = 'FS_NOT_FOUND';
      throw err;
    }
    const target = await fs.resolve(`${historyFolder(rel)}/${name}`, { cwd: root });
    return fs.readText(target);
  };

  return {
    readMaybe, listMd, write, writeGuarded, chapters, latestChapter, chapterTail, recentChapterTails,
    snapshot, snapshots: listSnapshots, readSnapshot,
  };
}

/** 保存一章正文到 正文/第NNN章-标题.md，返回相对路径 */
export async function saveChapter(io, num, title, body) {
  const file = chapterFile(num, title);
  await io.write(file, body);
  return file;
}

/** 初始化工程骨架；返回写入的相对路径清单 */
export async function scaffold(io, title) {
  const t = title || '未命名作品';
  await io.write(PROJECT.readme, `# ${t}

> 作品索引（由创作工作台 / creator_project 维护，双链导航）

- 简介：
- 状态：

## 快速导航

- [[伏笔清单]] · [[时间线]] · [[大纲/总纲|总纲]]
- [[人物卡/_索引|人物卡]] · [[设定集/_索引|设定集]]
- 章节：见下方（整理索引后自动生成）
`);
  await io.write(PROJECT.foreshadow, `# 伏笔清单

| 伏笔 | 铺设位置 | 发酵 | 回收位置 | 状态 |
| --- | --- | --- | --- | --- |
`);
  await io.write(PROJECT.timeline, `# 时间线

| 时间 | 事件 | 参与人物 | 影响/后续 |
| --- | --- | --- | --- |
`);
  await io.write(`${PROJECT.outline}/总纲.md`, '# 总纲\n\n## 核心设定\n\n## 主线\n\n## 分卷规划\n');
  await io.write(`${PROJECT.settings}/_索引.md`, '# 设定集索引\n\n> 每类设定一个文件；文件之间与人物卡用双链互相关联（如 [[主角]]、[[设定集/力量体系|力量体系]]）\n\n');
  await io.write(`${PROJECT.settings}/世界观.md`, '# 世界观\n\n（核心世界观设定；相关链接：[[设定集/力量体系]]、[[设定集/地理]]）\n');
  await io.write(`${PROJECT.settings}/力量体系.md`, '# 力量体系\n\n（等级/功法/战力规则与代价）\n');
  await io.write(`${PROJECT.settings}/地理.md`, '# 地理\n\n（大陆/国家/城市/重要地点）\n');
  await io.write(`${PROJECT.settings}/势力.md`, '# 势力\n\n（宗门/家族/组织/阵营）\n');
  await io.write(`${PROJECT.characters}/_索引.md`, '# 人物卡索引\n\n> 每个角色一个文件；关系用双链互链（如 [[林远]]），设定关联用 [[设定集/xxx]]\n\n');
  await io.write(`${PROJECT.archive}/说明.md`, '# 归档\n\n每章归档一个文件：第NNN章-归档.md（由 creator_archive 落盘）\n');
  await io.write(`${PROJECT.chapters}/说明.md`, '# 正文\n\n每章一个文件：`第NNN章-标题.md`\n');
  await io.write(PROJECT.styleCard, '# 文风卡\n\n> 按《novel-project》的文风卡格式，从基准章节生成后保存到本文件；写正文前必读对齐。重新生成直接覆盖。\n');
  return SCAFFOLD_FILES.slice();
}

/**
 * 工程进度统计（工作台总览与 creator_project 共用）。
 * 返回结构刻意做成可直接 JSON 化的数据，Host 路由原样发给前端。
 */
export async function projectStats(io) {
  const chapters = await io.chapters();
  const rows = [];
  let total = 0;
  for (const c of chapters) {
    const text = await io.readMaybe(`${PROJECT.chapters}/${c.file}`);
    const chars = countChars(text || '');
    total += chars;
    rows.push({
      file: c.file,
      num: c.num,
      title: c.title,
      chars,
      mark: chars === 0 ? '空文件' : chars < CHAPTER_MIN ? '偏短' : chars > CHAPTER_MAX ? '偏长' : '',
    });
  }
  const avg = rows.length ? Math.round(total / rows.length) : 0;
  const short = rows.filter((r) => r.chars > 0 && r.chars < CHAPTER_MIN).length;
  const long = rows.filter((r) => r.chars > CHAPTER_MAX).length;
  const empty = rows.filter((r) => r.chars === 0).length;

  const readme = await io.readMaybe(PROJECT.readme, 4000);
  const titleMatch = (readme || '').match(/^#\s+(.+)$/m);
  const meta = readmeMeta(readme);
  const foreshadowText = await io.readMaybe(PROJECT.foreshadow, 3000);
  const audit = foreshadowText ? auditForeshadow(foreshadowText, (rows.length ? rows[rows.length - 1].num : 0) + 1) : null;

  const tree = {
    [PROJECT.outline]: await io.listMd(PROJECT.outline),
    [PROJECT.settings]: await io.listMd(PROJECT.settings),
    [PROJECT.characters]: await io.listMd(PROJECT.characters),
    [PROJECT.archive]: await io.listMd(PROJECT.archive),
  };

  const timelineText = await io.readMaybe(PROJECT.timeline, 200);
  const styleText = await io.readMaybe(PROJECT.styleCard, 200);
  const initialized = Boolean(
    (readme && readme.trim()) ||
    rows.length ||
    tree[PROJECT.outline].length ||
    tree[PROJECT.settings].length ||
    (foreshadowText && foreshadowText.trim()),
  );

  return {
    initialized,
    title: titleMatch ? titleMatch[1].trim() : '',
    chapters: rows,
    counts: { chapters: rows.length, total, avg, short, long, empty },
    tree,
    goal: parseGoal(meta),
    special: {
      foreshadow: Boolean(foreshadowText && foreshadowText.trim()),
      timeline: Boolean(timelineText && timelineText.trim()),
      style: Boolean(styleText && styleText.trim()),
      readme: Boolean(readme && readme.trim()),
    },
    foreshadow: audit
      ? {
        total: audit.total,
        open: audit.openCount,
        stale: audit.stale.slice(0, 12),
        // 未回收条目（含清单行号），总览快捷视图点击直达用；最多 12 条防爆 payload
        openItems: audit.open.slice(0, 12).map((i) => ({ name: i.name, laidAt: i.laidAt, gap: i.gap, line: i.line })),
      }
      : { total: 0, open: 0, stale: [], openItems: [] },
  };
}

/**
 * 全文检索：只在作品工程的 Markdown 范围内搜（正文/大纲/设定集/人物卡/归档 +
 * 追踪文件），不读工作区里无关的代码或配置。返回行号与上下文片段，供工作台
 * 直接跳转；有文件/结果上限，避免整本书把内存和上下文撑爆。
 * @param {any} io openProject 返回的工程 IO
 * @param {string} query 关键词（至少 2 个字符）
 * @param {{limit?:number,maxFiles?:number,maxFileChars?:number}} [options]
 */
export async function searchProject(io, query, options = {}) {
  const q = String(query || '').trim();
  const limit = Math.min(Math.max(Number(options.limit) || 60, 1), 200);
  const maxFiles = Math.min(Math.max(Number(options.maxFiles) || 400, 1), 1000);
  const maxFileChars = Math.min(Math.max(Number(options.maxFileChars) || 200000, 1000), 500000);
  if (q.length < 2) {
    return { query: q, total: 0, scanned: 0, truncated: false, results: [] };
  }
  const needle = q.toLowerCase();
  const files = [];
  const chapters = await io.chapters();
  for (const chapter of chapters.slice().reverse()) files.push(`${PROJECT.chapters}/${chapter.file}`);
  for (const dir of [PROJECT.outline, PROJECT.settings, PROJECT.characters, PROJECT.archive]) {
    for (const name of await io.listMd(dir)) files.push(`${dir}/${name}`);
  }
  for (const special of [PROJECT.readme, PROJECT.foreshadow, PROJECT.timeline, PROJECT.styleCard]) {
    files.push(special);
  }

  const results = [];
  let scanned = 0;
  let truncated = false;
  const seen = new Set();
  for (const file of files) {
    if (results.length >= limit || scanned >= maxFiles) { truncated = true; break; }
    if (seen.has(file)) continue;
    seen.add(file);
    scanned += 1;
    const text = await io.readMaybe(file, maxFileChars);
    if (text === null) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      const at = raw.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      const start = Math.max(0, at - 48);
      const end = Math.min(raw.length, at + q.length + 80);
      const piece = raw.slice(start, end).trim();
      results.push({
        path: file,
        line: i + 1,
        preview: `${start > 0 ? '…' : ''}${piece}${end < raw.length ? '…' : ''}`,
      });
      if (results.length >= limit) { truncated = true; break; }
    }
  }
  return { query: q, total: results.length, scanned, truncated, results };
}

// ---------------- 全书体检 / 纯文本导出 / 写作活动 ----------------

/**
 * 全书体检：逐章跑 41 项规则并按章汇总，供工作台「全书体检」面板使用。
 * 工程可能有几百章，一次全量读入会卡死浏览器，所以做成游标式：
 *   1. 每次调用只读 offset 起的 batch 章正文，单章超限截断（体检不受影响）；
 *   2. 报告只保留问题章（硬违规/建议各留前几条），干净章只计总数；
 *   3. 返回 next 下一批游标，读完为 null——调用方循环到 null 或主动停止。
 * 中途停止不丢结果：已扫的批次照常渲染。lint 硬违规 = 结构/标点纪律，软违规
 * = 禁词/句式建议；与 lintText 的分级约定完全一致。
 * @param {any} io openProject 返回的工程 IO
 * @param {{offset?:number,batch?:number,tailChars?:number,keep?:number}} [options]
 */
export async function scanBook(io, options = {}) {
  const offset = Math.max(0, Number(options.offset) || 0);
  const batch = Math.min(Math.max(Number(options.batch) || 10, 1), 50);
  const tailChars = Math.min(Math.max(Number(options.tailChars) || 60000, 5000), 100000);
  const keep = Math.min(Math.max(Number(options.keep) || 4, 1), 10);
  const chapters = await io.chapters();
  // 游标越界（断点续扫期间章节被删等）按「读完」处理，不产生负数批次
  if (offset >= chapters.length) {
    return {
      done: true, offset, next: null, scanned: 0, chapters: [],
      hardTotal: 0, softTotal: 0, cleanChapters: 0, total: chapters.length, truncated: false,
    };
  }
  const end = Math.min(offset + batch, chapters.length);
  const rows = [];
  let hardTotal = 0;
  let softTotal = 0;
  let cleanChapters = 0;
  for (const c of chapters.slice(offset, end)) {
    const text = await io.readMaybe(`${PROJECT.chapters}/${c.file}`, tailChars);
    const chars = countChars(text || '');
    const result = lintText(text || '');
    hardTotal += result.hardCount;
    softTotal += result.softCount;
    const hard = result.issues.filter((i) => i[0] === 'hard').map(([, name, detail]) => ({ name, detail }));
    const soft = result.issues.filter((i) => i[0] === 'soft').map(([, name, detail]) => ({ name, detail }));
    if (!hard.length && !soft.length) cleanChapters += 1;
    rows.push({
      num: c.num,
      file: c.file,
      chars,
      hardCount: result.hardCount,
      softCount: result.softCount,
      hard: hard.slice(0, keep),
      soft: soft.slice(0, keep),
    });
  }
  const done = end >= chapters.length;
  return {
    done,
    offset,
    next: done ? null : end,
    scanned: end - offset,
    chapters: rows,
    hardTotal,
    softTotal,
    cleanChapters,
    total: chapters.length,
    truncated: end < chapters.length,
  };
}

/**
 * Markdown → 纯文本（网文平台投稿格式）。章节标题独立成行；正文去掉 Markdown
 * 语法但保留文字内容：
 *   - 标题符 #、强调 ** *、行内代码 `、图片 ![alt](src) 丢格式留文字；
 *   - 链接 [文字](地址) 只保留文字；
 *   - 双链 [[文字]] / [[目标|别名]] 保留别名或目标文字；
 *   - 引用 > 与列表符 - * 1. 去标记留内容；
 *   - 表格行转「a · b · c」并列，分隔行整行丢弃；
 *   - 水平线 --- *** 整行删除；
 *   - 转义符 \@ 还原本字；
 *   - 段落间统一空一行（中文投稿习惯，无连续空段）。
 * @param {string} markdown 全本 Markdown 文本
 * @returns {string} 纯文本
 */
export function toPlainText(markdown) {
  const source = String(markdown || '');
  const inline = (s) => String(s || '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\s][^*]*)\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\\(.)/g, '$1');
  const out = [];
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { out.push(''); continue; }
    if (/^(−{3,}|-{3,}|\*{3,}|_{3,})$/.test(line)) continue;
    if (/^\|/.test(line)) {
      if (/^[\s|:-]+$/.test(line)) continue;
      const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => inline(c.trim())).filter(Boolean);
      if (cells.length) out.push(cells.join(' · '));
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) { out.push(inline(heading[1])); continue; }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) { out.push(inline(quote[1])); continue; }
    const li = line.match(/^(?:[-*+]|\d+[.、)])\s+(.+)$/);
    if (li) { out.push(inline(li[1])); continue; }
    out.push(inline(line));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 本地日历日的 YYYYMMDD 键 */
function dayKeyOf(ts) {
  const d = new Date(ts);
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/**
 * 写作活动统计（只读）：从历史快照与章节文件的修改时间推最近 14 天的写作
 * 痕迹。数据来源与口径：
 *   - 保存次数 = `.history/<路径>/YYYYMMDD-HHMMSS-xxxx.md` 快照名自带时间戳，
 *     每个手工保存一条，自动保存不产生——统计的是「人工保存强度」；
 *   - 新增字数 = 相邻快照的体积近似字数差（新快照比前一版多出的部分，负值记
 *     0）；快照是保存前文本，以「下一版」为末端点计增量。样本不足 2 个的文件
 *     按「末次近似字数 / 出现天数」均摊，避免首版全记成一天虚高。UTF-8 中文
 *     每字约 3 字节，体积差 / 3 是足够好的近似，不必逐个读快照全文；
 *   - 写作日 = 快照日期 ∪ 有正文章节文件的 mtime 日期（mtime 是最后手段，
 *     只用于判断「哪天动过」，不用于字数）；
 *   - 连续天数 = 今天往前数，直到第一个不在写作日集合里的日子为止。
 * 任何读取失败都按空数据处理，不抛错——统计是锦上添花，不能变成报错页面。
 * @param {any} io openProject 返回的工程 IO
 * @param {any} fs 组合文件系统服务（stat 需要，可缺省）
 * @param {string} root 工作区根
 * @param {{days?:number,now?:number}} [options] now 仅测试注入
 */
export async function activityReport(io, fs, root, options = {}) {
  const windowDays = Math.min(Math.max(Number(options.days) || 14, 1), 60);
  const now = Number(options.now) || Date.now();
  const startTs = new Date(now).setHours(0, 0, 0, 0) - (windowDays - 1) * 86400000;
  const daily = new Map();
  for (let i = 0; i < windowDays; i += 1) {
    daily.set(dayKeyOf(startTs + i * 86400000), { saves: 0, added: 0 });
  }

  const bump = (key, field, n) => {
    const bucket = daily.get(key);
    if (bucket && Number.isFinite(n)) bucket[field] += n;
  };
  const estimate = (size) => Math.max(0, Math.round(size / 3));
  const activeKeys = new Set();

  // 1) 历史快照：保存次数 + 字数增量
  const chapters = await io.chapters();
  const trackFiles = [PROJECT.readme, PROJECT.foreshadow, PROJECT.timeline, PROJECT.styleCard];
  for (const file of chapters.map((c) => `${PROJECT.chapters}/${c.file}`).concat(trackFiles)) {
    const snaps = await io.snapshots(file);
    const inWindow = snaps
      .map((s) => {
        const m = s.name.match(/^(\d{8})-\d{6}-[a-z0-9]{4}\.md$/);
        return m ? { name: s.name, key: m[1], path: s.path, size: s.size || 0 } : null;
      })
      .filter((s) => s && daily.has(s.key));
    if (!inWindow.length) continue;
    // listDir 不保证带 size：体积缺失的快照补一次 stat，拿不到就按 0 处理
    if (fs && typeof fs.stat === 'function') {
      for (const s of inWindow) {
        if (s.size) continue;
        try {
          const info = await fs.stat(await fs.resolve(s.path, { cwd: root }));
          if (info && info.type === 'file') s.size = info.size || 0;
        } catch (err) { /* 保持 0，字数增量少算一点不致命 */ }
      }
    }
    // 快照按时间升序处理；体积分度差近似新增字数（新快照 − 前一版，负值记 0）
    const ordered = inWindow.slice().sort((a, b) => a.name.localeCompare(b.name));
    for (let i = 0; i < ordered.length; i += 1) {
      bump(ordered[i].key, 'saves', 1);
      activeKeys.add(ordered[i].key);
      const prev = i > 0 ? ordered[i - 1].size : 0;
      bump(ordered[i].key, 'added', Math.max(0, estimate(ordered[i].size) - estimate(prev)));
    }
    if (ordered.length < 2) {
      // 单快照无法差分：按出现天数均摊近似字数，避免首版全记成一天
      bump(ordered[0].key, 'added', Math.round(estimate(ordered[0].size) / ordered.length));
    }
  }

  // 2) 章节文件 mtime：哪怕没有快照（自动保存/外部写入）也认作写作痕迹。
  //    stat/fs 不可用或单文件失败都跳过，不影响快照口径的部分。
  if (fs && typeof fs.stat === 'function') {
    const latest = chapters.length ? chapters[chapters.length - 1] : null;
    const targets = chapters.map((c) => `${PROJECT.chapters}/${c.file}`);
    if (latest) targets.push(`${PROJECT.outline}/总纲.md`);
    for (const rel of targets) {
      try {
        const target = await fs.resolve(rel, { cwd: root });
        const info = await fs.stat(target);
        if (!info || info.type !== 'file') continue;
        const key = dayKeyOf(info.mtimeMs || 0);
        if (daily.has(key)) activeKeys.add(key);
      } catch (err) { /* 单文件失败跳过 */ }
    }
  }

  const activeDays = [...activeKeys].filter((k) => daily.has(k)).sort();
  let streak = 0;
  for (let i = 0; i < 400; i += 1) {
    const key = dayKeyOf(new Date(now).setHours(0, 0, 0, 0) - i * 86400000);
    if (!activeDays.includes(key)) break;
    streak += 1;
  }
  return {
    days: windowDays,
    daily: [...daily.entries()].map(([key, value]) => ({ key, saves: value.saves, added: value.added })),
    streak,
    writingDays: activeDays.length,
    activeDays,
  };
}

/** 从 README 里提取可保留的元信息（整理索引时不能把作者写的简介/状态清空） */
export function readmeMeta(text) {
  const source = String(text || '');
  const pick = (re) => {
    const m = source.match(re);
    return m ? m[1].trim() : '';
  };
  return {
    title: pick(/^#\s+(.+)$/m),
    intro: pick(/^-\s*简介：(.+)$/m),
    status: pick(/^-\s*状态：(.+)$/m),
    goalChars: pick(/^-\s*目标字数：(.+)$/m),
    goalDate: pick(/^-\s*目标完稿：(.+)$/m),
  };
}

/**
 * 从 README 元信息行解析写作目标。目标字数取纯数字（「120 万」→ 1200000，
 * 「800000」原样）；目标完稿日期取 YYYY-MM-DD 或 YYYY/MM/DD。都没有时返回
 * null——总览按「未设目标」渲染。解析不出合法值的行按无目标处理，不报错。
 */
export function parseGoal(meta) {
  const source = meta || {};
  let chars = null;
  const rawChars = String(source.goalChars || '').replace(/[,，\s]/g, '');
  if (rawChars) {
    const m = rawChars.match(/^(\d+)(?:万)?字?$/);
    if (m) {
      chars = parseInt(m[1], 10) * (m[2] === undefined && /万$/.test(rawChars) ? 10000 : 1);
      if (chars <= 0) chars = null;
    }
  }
  let date = null;
  const rawDate = String(source.goalDate || '').trim();
  const dm = rawDate.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (dm) {
    const y = parseInt(dm[1], 10);
    const mo = parseInt(dm[2], 10);
    const d = parseInt(dm[3], 10);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  if (chars === null && date === null) return null;
  return { chars, date };
}

/**
 * 更新 README 里的写作目标两行（- 目标字数： / - 目标完稿：）。纯函数：
 * 输入当前 README 文本与目标，返回新文本。字段语义：
 *   - undefined → 不动这一行；null → 删除这一行（清除该目标）；
 *   - 数字/字符串 → 写入（行已存在原位替换，不存在追加到元信息块之后）。
 * 作者写的简介与其他内容不动。
 * @param {string} readme 当前 README 文本
 * @param {{chars?:number|null, date?:string|null}} goal 新目标
 */
export function writeGoal(readme, goal) {
  const source = String(readme || '');
  const g = goal || {};
  const setChars = g.chars === undefined ? null : (g.chars ? Number(g.chars) : null);
  const setDate = g.date === undefined ? null : (g.date ? String(g.date) : null);
  const charsLine = setChars ? `- 目标字数：${setChars}` : '';
  const dateLine = setDate ? `- 目标完稿：${setDate}` : '';
  // 替换已存在的行；返回 null 表示该行原本不存在。undefined 表示不动。
  const replaceLine = (text, re, line) => (line === null ? text : (re.test(text) ? (line ? text.replace(re, line) : text.replace(re, '')) : null));
  let next = replaceLine(source, /^-\s*目标字数：.*\n?/m, g.chars === undefined ? null : (charsLine ? `${charsLine}\n` : ''));
  if (next === null) next = source;
  let out = replaceLine(next, /^-\s*目标完稿：.*\n?/m, g.date === undefined ? null : (dateLine ? `${dateLine}\n` : ''));
  if (out === null) out = next;
  // 要写入但行原本不存在：插到元信息块尾部——第一个「## 」标题之前，且
  // 不越过非元信息的普通行（简介/状态/章节数这类 - 行之后）。找不到锚点
  // （非约定格式的 README）时追加到文件末尾，同样能被 readmeMeta 读到。
  const missingChars = setChars && !/^-\s*目标字数：/m.test(out);
  const missingDate = setDate && !/^-\s*目标完稿：/m.test(out);
  if (missingChars || missingDate) {
    const lines = out.replace(/\n+$/, '').split('\n');
    let at = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (/^##\s/.test(lines[i])) break;
      if (/^-\s*(简介|状态|章节数|目标字数|目标完稿)：/.test(lines[i])) at = i;
    }
    const insert = [];
    if (missingChars) insert.push(charsLine);
    if (missingDate) insert.push(dateLine);
    if (at >= 0) lines.splice(at + 1, 0, ...insert);
    else lines.push('', ...insert);
    out = `${lines.join('\n')}\n`;
  }
  return out.replace(/\n{3,}$/g, '\n\n');
}

/** 整理作品索引（README + 人物卡/设定集索引），返回摘要行 */
export async function rebuildIndex(io, title) {
  const previous = await io.readMaybe(PROJECT.readme, 6000);
  const meta = readmeMeta(previous);
  const t = title || meta.title || '未命名作品';
  const chapters = await io.listMd(PROJECT.chapters);
  const chars = await io.listMd(PROJECT.characters);
  const sets = await io.listMd(PROJECT.settings);
  const arcs = await io.listMd(PROJECT.archive);
  const skip = (f) => f !== '_索引.md' && f !== '说明.md';
  const chapterLinks = chapters.map((c) => `- [[${c.replace(/\.md$/, '')}]]`).join('\n');
  const charLinks = chars.filter(skip).map((c) => `- [[人物卡/${c.replace(/\.md$/, '')}|${c.replace(/\.md$/, '')}]]`).join('\n');
  const setLinks = sets.filter(skip).map((s) => `- [[设定集/${s.replace(/\.md$/, '')}|${s.replace(/\.md$/, '')}]]`).join('\n');
  const arcLinks = arcs.filter(skip).map((a) => `- [[归档/${a.replace(/\.md$/, '')}|${a.replace(/\.md$/, '')}]]`).join('\n');
  await io.write(PROJECT.readme, `# ${t}

> 作品索引（由创作工作台 / creator_project 维护）

- 简介：${meta.intro}
- 状态：${meta.status}
- 章节数：${chapters.length}
- 目标字数：${meta.goalChars || ''}
- 目标完稿：${meta.goalDate || ''}

## 章节

${chapterLinks || '（暂无）'}

## 人物

${charLinks || '（暂无）'}

## 设定

${setLinks || '（暂无）'}

## 归档

${arcLinks || '（暂无）'}

## 追踪

- [[伏笔清单]] · [[时间线]] · [[大纲/总纲|总纲]]
`);
  if (chars.filter(skip).length > 0) {
    await io.write(`${PROJECT.characters}/_索引.md`, `# 人物卡索引\n\n> 每个角色一个文件；关系用双链互链（如 [[林远]]）\n\n${chars.filter(skip).map((c) => `- [[人物卡/${c.replace(/\.md$/, '')}|${c.replace(/\.md$/, '')}]]`).join('\n')}\n`);
  }
  if (sets.filter(skip).length > 0) {
    await io.write(`${PROJECT.settings}/_索引.md`, `# 设定集索引\n\n> 每类设定一个文件；与人物卡用双链互相关联\n\n${sets.filter(skip).map((s) => `- [[设定集/${s.replace(/\.md$/, '')}|${s.replace(/\.md$/, '')}]]`).join('\n')}\n`);
  }
  return `已整理索引：README.md（${chapters.length} 章、${chars.filter(skip).length} 人物、${sets.filter(skip).length} 设定，全部双链）`;
}
