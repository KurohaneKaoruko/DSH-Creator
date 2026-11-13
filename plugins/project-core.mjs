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
 * 返回 { total, openCount, stale[] }；表格不可解析时返回 null。
 * @param {string} table 伏笔清单 Markdown 表格
 * @param {number} currentNum 当前章号
 */
export function auditForeshadow(table, currentNum) {
  const rows = String(table || '').split('\n').filter((l) => l.trim().startsWith('|'));
  if (rows.length < 2) return null;
  const cellsOf = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const header = cellsOf(rows[0]);
  const idx = { name: 0, laid: 1, status: Math.max(0, header.length - 1) };
  header.forEach((h, i) => {
    if (/伏笔|名称|条目/.test(h)) idx.name = i;
    else if (/铺设|埋设|起始/.test(h)) idx.laid = i;
    else if (/状态/.test(h)) idx.status = i;
  });
  const items = [];
  for (const row of rows.slice(1)) {
    const cells = cellsOf(row);
    // 跳过 | --- | --- | 分隔行
    if (cells.every((c) => c === '' || /^:?-{2,}:?$/.test(c))) continue;
    const name = cells[idx.name] || '';
    if (!name || name === '伏笔') continue;
    const status = cells[idx.status] || '';
    const open = !/已回收|已收|已填|已兑现|已完成/.test(status);
    const m = (cells[idx.laid] || '').match(/第\s*(\d+)\s*章/);
    const laidAt = m ? parseInt(m[1], 10) : null;
    const gap = laidAt !== null && currentNum ? currentNum - laidAt : null;
    items.push({ name, status, laidAt, gap, open });
  }
  if (!items.length) return null;
  const openItems = items.filter((i) => i.open);
  const stale = openItems
    .filter((i) => i.gap !== null && i.gap >= STALE_CHAPTERS)
    .sort((a, b) => b.gap - a.gap);
  return { total: items.length, openCount: openItems.length, stale };
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
    special: {
      foreshadow: Boolean(foreshadowText && foreshadowText.trim()),
      timeline: Boolean(timelineText && timelineText.trim()),
      style: Boolean(styleText && styleText.trim()),
      readme: Boolean(readme && readme.trim()),
    },
    foreshadow: audit
      ? { total: audit.total, open: audit.openCount, stale: audit.stale.slice(0, 12) }
      : { total: 0, open: 0, stale: [] },
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
  };
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
