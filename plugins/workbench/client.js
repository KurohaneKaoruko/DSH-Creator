// 创作工作台 · Client 侧
// -----------------------------------------------------------------------------
// 整页视图注册在 conversation.view（会话头部视图切换器）。这是 DSH-Creator 的
// 主入口：一个作品工程的工作台，四个创作助手是它里面的角色。
//
//   顶部：助手切换（小说 / 编剧 / 游戏剧本 / 通用）+ 刷新
//   左侧：作品工程导航（正文 / 大纲 / 设定集 / 人物卡 / 归档 / 追踪文件）
//   中间：阅读 / 编辑（小说排版、对话高亮、双链、字数）
//   右侧：正文检查结果、进度摘要、交给助手的快捷指令
//
// 读取走官方 Remote（workspaceFiles），写入与工程操作走 Host 路由
// /creator-workbench/v1/api（index.js）。所有字符串只使用 --dsw-alias-* 主题
// token，亮暗主题自动跟随。

window.__ModuleLoader__.load({
  id: 'dsh-creator',
  factory(require) {
    const React = require('react');
    // 宿主 builtin 的 React 面不保证暴露全部 hooks 与 class API（inspect 只保证
    // createElement/useState/useEffect）。缺什么就补最小实现：useMemo/useRef/
    // useCallback 用 useState 兜底模拟；Component 缺失则错误边界退化为函数包装。
    const safeHooks = {};
    for (const name of ['useState', 'useEffect', 'useMemo', 'useRef', 'useCallback']) {
      if (typeof React[name] === 'function') safeHooks[name] = React[name];
    }
    if (typeof safeHooks.useState !== 'function') {
      throw new Error('creator-workbench: 宿主 React 缺少 useState，无法挂载工作台');
    }
    if (typeof safeHooks.useEffect !== 'function') safeHooks.useEffect = () => {};
    if (typeof safeHooks.useRef !== 'function') safeHooks.useRef = (v) => ({ current: v });
    if (typeof safeHooks.useMemo !== 'function') safeHooks.useMemo = (f) => f();
    if (typeof safeHooks.useCallback !== 'function') safeHooks.useCallback = (f) => f;
    const { useState, useEffect, useMemo, useRef, useCallback } = safeHooks;
    const h = React.createElement;

    const API = '/creator-workbench/v1/api';
    const CHAPTER_RE = /^第[零〇一二两三四五六七八九十百千0-9]+[章回节集][^\n]*$/;

    // 四个创作助手：id 与 cordis.patch.yml 的预设 id 一致
    const ASSISTANTS = [
      { id: 'novelist', label: '小说', name: '小说助手' },
      { id: 'screenwriter', label: '编剧', name: '编剧助手' },
      { id: 'gamescript', label: '游戏剧本', name: '游戏剧本助手' },
      { id: 'general-creator', label: '通用', name: '通用创作助手' },
    ];

    const TREE_SECTIONS = [
      { key: 'outline', label: '大纲', dir: '大纲' },
      { key: 'settings', label: '设定集', dir: '设定集' },
      { key: 'characters', label: '人物卡', dir: '人物卡' },
      { key: 'archive', label: '归档', dir: '归档' },
    ];

    const SPECIAL_FILES = [
      { path: 'README.md', label: '作品索引', flag: 'readme' },
      { path: '伏笔清单.md', label: '伏笔清单', flag: 'foreshadow' },
      { path: '时间线.md', label: '时间线', flag: 'timeline' },
      { path: '文风卡.md', label: '文风卡', flag: 'style' },
    ];

    // ---------------- 工具 ----------------

    /** 兼容 RemoteResult 与旧版直返值 */
    function unwrap(value) {
      if (value && typeof value === 'object' && typeof value.ok === 'boolean') {
        if (!value.ok) throw new Error((value.error && value.error.message) || '远程调用失败');
        return value.value;
      }
      return value;
    }

    function countWords(text) {
      const cjk = (String(text || '').match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
      const latin = (String(text || '').match(/[a-zA-Z]+/g) || []).length;
      return cjk + latin;
    }

    /** 与 project-core.hashText 完全一致的 FNV-1a 32 位指纹，用于保存冲突检测 */
    function hashText(text) {
      let hash = 0x811c9dc5;
      const source = String(text || '');
      for (let i = 0; i < source.length; i += 1) {
        hash ^= source.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
      }
      return (hash >>> 0).toString(16).padStart(8, '0');
    }

    /** 与 project-core.toPlainText 完全一致的 Markdown → 纯文本，用于 TXT 投稿导出 */
    function toPlainText(markdown) {
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

    // window.confirm 不可用的宿主（定制 WebView 等）里，不可静默丢弃用户数据：
    // 切文件/回总览按「保留草稿」处理——草稿留在缓存里，下次打开再问一次；
    // 只有用户在确认框里明确点了放弃，或走显式的 force 路径，才清缓存。
    const canConfirm = () => typeof window.confirm === 'function';

    // 本地草稿缓存：浏览器崩溃/被强杀时，服务端来不及保存的内容还能找回。
    // 保存成功后清除；切文件/回总览并确认放弃时也清除，避免旧草稿反复弹出。
    const DRAFT_CACHE_PREFIX = 'dsh-creator:draft';
    const DRAFT_CACHE_LIMIT = 2000000;

    function draftCacheKey(sessionId, path) {
      return `${DRAFT_CACHE_PREFIX}:${sessionId}:${path}`;
    }

    function loadDraftCache(sessionId, path) {
      try {
        const raw = window.localStorage.getItem(draftCacheKey(sessionId, path));
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!data || typeof data.text !== 'string' || data.text.length > DRAFT_CACHE_LIMIT) return null;
        if (!Number.isFinite(data.savedAt)) return null;
        return data;
      } catch (err) { return null; }
    }

    function saveDraftCache(sessionId, path, text, baseHash) {
      if (!sessionId || !path || text.length > DRAFT_CACHE_LIMIT) return false;
      try {
        window.localStorage.setItem(draftCacheKey(sessionId, path), JSON.stringify({
          text, baseHash, savedAt: Date.now(),
        }));
        return true;
      } catch (err) { return false; }
    }

    function clearDraftCache(sessionId, path) {
      try { window.localStorage.removeItem(draftCacheKey(sessionId, path)); } catch (err) { /* noop */ }
    }

    /**
     * 解析双链目标 → 工程文件相对路径。解析顺序：追踪文件 → 章节 → 人物卡 →
     * 设定集 → 大纲 → 归档；带目录前缀的目标（[[人物卡/林远|阿远]]，整理索引
     * 生成的就是这种）按目录约定直接解析。找不到返回 null，交给「未建档 →
     * 一键补建」流程。stats 来自 /stats，只用于查已有文件，缺省时按约定解析。
     */
    function resolveWikiLink(target, stats) {
      const raw = String(target || '').trim().replace(/\.md$/i, '');
      if (!raw) return null;
      const segs = raw.split('/').map((s) => s.trim()).filter(Boolean);
      if (!segs.length || segs.some((s) => s.startsWith('.'))) return null;
      if (segs.length > 1) return `${segs.join('/')}.md`;
      const name = segs[0];
      const special = {
        '伏笔清单': '伏笔清单.md',
        '时间线': '时间线.md',
        '文风卡': '文风卡.md',
        'README': 'README.md',
        '作品索引': 'README.md',
      };
      if (special[name]) return special[name];
      const chapters = (stats && stats.chapters) || [];
      const chapter = chapters.find((c) => String(c.file || '').replace(/\.md$/, '') === name);
      if (chapter) return `${'正文'}/${chapter.file}`;
      const tree = (stats && stats.tree) || {};
      for (const dir of ['人物卡', '设定集', '大纲', '归档']) {
        const files = tree[dir] || [];
        if (files.some((f) => String(f).replace(/\.md$/, '') === name)) return `${dir}/${name}.md`;
      }
      return null;
    }

    /** 双链一键建档的最小骨架：人物卡与设定集各有一份模板，其余目录给标题占位 */
    function wikiSkeleton(dir, name) {
      if (dir === '人物卡') {
        return `# ${name}\n\n> 人物卡（由正文双链创建，待补全）\n\n- 身份：\n- 外貌：\n- 性格：\n- 能力：\n- 人际关系：\n- 首次出场：\n`;
      }
      if (dir === '设定集') {
        return `# ${name}\n\n> 设定条目（由正文双链创建，待补全）\n\n- 概述：\n- 规则/边界：\n- 关联设定：[[设定集/_索引|设定集索引]]\n`;
      }
      return `# ${name}\n\n（由双链创建，待补全）\n`;
    }

    function formatWhen(ts) {
      try {
        return new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      } catch (err) { return '上次'; }
    }

    function formatSnapshotName(name) {
      const match = String(name || '').match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-[a-z0-9]{4}\.md$/);
      if (!match) return name;
      return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
    }

    function fmt(n) {
      return String(Number(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    function fileName(path) {
      const parts = String(path || '').split('/');
      return parts[parts.length - 1] || path;
    }

    async function postJson(action, payload) {
      const res = await fetch(`${API}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        const error = new Error((data.error && data.error.message) || `请求失败（HTTP ${res.status}）`);
        error.code = data.error && data.error.code;
        error.status = res.status;
        throw error;
      }
      return data.data === undefined ? data : data.data;
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (err) {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        let done = false;
        try { done = document.execCommand('copy'); } catch (e) { done = false; }
        document.body.removeChild(area);
        return done;
      }
    }

    // ---------------- 小说排版渲染 ----------------

    const INLINE_RE = /(\*\*[^*]+\*\*|\[\[[^\]]+\]\]|“[^”]*”|\*[^*\s][^*]*\*)/g;

    function renderInline(text, prefix, openWikiLink) {
      const out = [];
      let last = 0;
      let index = 0;
      const source = String(text || '');
      source.replace(INLINE_RE, (match, token, offset) => {
        if (offset > last) out.push(source.slice(last, offset));
        if (token.startsWith('**')) {
          out.push(h('strong', { key: `${prefix}-b${index++}` }, token.slice(2, -2)));
        } else if (token.startsWith('[[')) {
          const target = token.slice(2, -2);
          const label = target.includes('|') ? target.split('|')[1].trim() : target;
          out.push(h('span', {
            key: `${prefix}-w${index++}`,
            className: 'cw-wikilink',
            style: { cursor: 'pointer' },
            title: `打开「${target.includes('|') ? target.split('|')[0].trim() : target}」`,
            onClick: () => openWikiLink(target),
          }, label));
        } else if (token.startsWith('“')) {
          out.push(h('span', { key: `${prefix}-q${index++}`, className: 'cw-quote' }, token));
        } else {
          out.push(h('em', { key: `${prefix}-i${index++}` }, token.slice(1, -1)));
        }
        last = offset + token.length;
        return match;
      });
      if (last < source.length) out.push(source.slice(last));
      return out;
    }

    function renderDocument(text, keyPrefix, openWikiLink) {
      const lines = String(text || '').split(/\r?\n/);
      const blocks = [];
      let table = [];
      let tableKey = 0;
      const flushTable = () => {
        if (!table.length) return;
        blocks.push(h('pre', { key: `${keyPrefix}-table-${tableKey++}`, className: 'cw-table' }, table.join('\n')));
        table = [];
      };
      for (let i = 0; i < lines.length; i += 1) {
        const raw = lines[i];
        const line = raw.trim();
        if (!line) { flushTable(); continue; }
        if (line.startsWith('|')) { table.push(line); continue; }
        flushTable();
        const key = `${keyPrefix}-${i}`;
        if (CHAPTER_RE.test(line)) {
          blocks.push(h('h2', { key, className: 'cw-chapter-title' }, line));
          continue;
        }
        const heading = line.match(/^(#{1,6})\s+(.+)$/);
        if (heading) {
          const level = Math.min(heading[1].length + 1, 6);
          blocks.push(h(`h${level}`, { key, className: 'cw-heading' }, heading[2]));
          continue;
        }
        if (/^(−{3,}|-{3,}|\*{3,})$/.test(line)) {
          blocks.push(h('hr', { key, className: 'cw-hr' }));
          continue;
        }
        if (line.startsWith('> ')) {
          blocks.push(h('blockquote', { key, className: 'cw-note' }, renderInline(line.slice(2), key, openWikiLink)));
          continue;
        }
        const li = line.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
        if (li) {
          blocks.push(h('div', { key, className: 'cw-li' }, h('span', { className: 'cw-li-mark' }, '·'), renderInline(li[1], key, openWikiLink)));
          continue;
        }
        blocks.push(h('p', { key, className: 'cw-p' }, renderInline(line, key, openWikiLink)));
      }
      flushTable();
      return blocks;
    }

    function NovelDoc({ text, fontSize, onOpenLink }) {
      const blocks = useMemo(() => renderDocument(text, 'doc', onOpenLink), [text, onOpenLink]);
      return h('article', { className: 'cw-article', style: { fontSize: `${fontSize}px` } }, blocks);
    }

    // ---------------- 检查结果 ----------------

    function LintList({ lint }) {
      if (!lint) {
        return h('div', { className: 'cw-muted' }, '还没有检查结果。保存或点「检查」后，这里列出硬违规与建议项。');
      }
      if (!lint.issues.length) {
        return h('div', { className: 'cw-lint-clear' }, '未发现可量化的违规。视角越界、说明书腔等仍需助手复核。');
      }
      return h('div', { className: 'cw-issues' },
        lint.issues.map((issue, index) => h('div', {
          key: `${issue.level}-${index}`,
          className: issue.level === 'hard' ? 'cw-issue cw-issue-hard' : 'cw-issue cw-issue-soft',
        },
        h('span', { className: 'cw-issue-tag' }, issue.level === 'hard' ? '必修' : '建议'),
        h('div', { className: 'cw-issue-body' },
          h('div', { className: 'cw-issue-name' }, issue.name),
          h('div', { className: 'cw-issue-detail' }, issue.detail)))));
    }

    // ---------------- 工作台 ----------------

    function StudioView({ ctx, sessionId }) {
      const wf = ctx.remote && ctx.remote.workspaceFiles;
      const ap = ctx.remote && ctx.remote.agentPresets;

      const [stats, setStats] = useState(null);
      const [hostError, setHostError] = useState('');
      const [loadingFile, setLoadingFile] = useState(false);
      const [busy, setBusy] = useState('');
      const [current, setCurrent] = useState(null);
      const [draft, setDraft] = useState('');
      const [dirty, setDirty] = useState(false);
      const [mode, setMode] = useState('read');
      const [fontSize, setFontSize] = useState(17);
      const [lint, setLint] = useState(null);
      const [preset, setPreset] = useState('');
      const [roster, setRoster] = useState([]);
      const [toast, setToast] = useState(null);
      const [projectTitle, setProjectTitle] = useState('');
      const [newTitle, setNewTitle] = useState('');
      const [newNumber, setNewNumber] = useState('');
      const [showNew, setShowNew] = useState(false);
      const [autoSave, setAutoSave] = useState(() => {
        try { return window.localStorage.getItem('dsh-creator:autosave') === '1'; } catch (err) { return false; }
      });
      const [query, setQuery] = useState('');
      const [searchResult, setSearchResult] = useState(null);
      const [searching, setSearching] = useState(false);
      const [conflict, setConflict] = useState(null);
      const [recovered, setRecovered] = useState(null);
      const [historyOpen, setHistoryOpen] = useState(false);
      const [historyList, setHistoryList] = useState([]);
      const [historyLoading, setHistoryLoading] = useState(false);
      const [scanOpen, setScanOpen] = useState(false);
      const [scanRows, setScanRows] = useState([]);
      const [scanProgress, setScanProgress] = useState('');
      const [scanResult, setScanResult] = useState(null);
      const [activity, setActivity] = useState(null);

      const toastTimer = useRef(null);
      const editorRef = useRef(null);
      const saveRef = useRef(null);
      const draftRef = useRef('');
      const statsRef = useRef(null);
      const api = useCallback((action, payload) => postJson(action, { sessionId, ...(payload || {}) }), [sessionId]);

      const showToast = useCallback((text, tone) => {
        setToast({ text, tone: tone || 'info' });
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(null), 4200);
      }, []);

      useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

      const refresh = useCallback(async () => {
        if (!sessionId) { setHostError('缺少会话标识：请从会话里打开工作台'); return; }
        try {
          const data = await api('stats');
          statsRef.current = data;
          setStats(data);
          setHostError('');
        } catch (err) {
          setHostError(String((err && err.message) || err));
        }
      }, [api, sessionId]);

      const readFile = useCallback(async (path) => {
        if (!wf) throw new Error('工作区文件服务不可用');
        if (!sessionId) throw new Error('缺少会话标识');
        const pages = [];
        let offset = 1;
        for (let i = 0; i < 60; i += 1) {
          const page = unwrap(await wf.read(sessionId, path, { offset }));
          pages.push(page.text != null ? page.text : (page.content || ''));
          if (page.eof !== false) break;
          const lines = Number(page.lines || 0);
          if (!lines) break;
          offset = Number(page.offset || offset) + lines;
        }
        return pages.join('\n');
      }, [wf, sessionId]);

      const openFile = useCallback(async (path, options = {}) => {
        const force = Boolean(options && options.force);
        if ((busy || loadingFile) && !force) return;
        if (!force && current && current.path === path) return;
        if (!force && dirty && current && current.path !== path) {
          if (!canConfirm()) {
            showToast('当前章节有未保存修改；草稿已保留在本地缓存，可随时回来恢复', 'warn');
            return;
          }
          const okToSwitch = window.confirm('当前章节有未保存修改，确定放弃并打开其他文件吗？');
          if (!okToSwitch) return;
          clearDraftCache(sessionId, current.path);
        }
        if (force) clearDraftCache(sessionId, path);
        setLoadingFile(true);
        setLint(null);
        setConflict(null);
        try {
          const text = await readFile(path);
          const cached = loadDraftCache(sessionId, path);
          let nextDraft = text;
          let nextDirty = false;
          let nextRecovered = null;
          let nextHash = hashText(text);
          if (cached && cached.text !== text) {
            const restoreDraft = typeof window.confirm !== 'function'
              || window.confirm(`检测到 ${formatWhen(cached.savedAt)} 的未保存草稿（约 ${countWords(cached.text)} 字），恢复吗？`);
            if (restoreDraft) {
              nextDraft = cached.text;
              nextDirty = true;
              nextRecovered = { savedAt: cached.savedAt, when: formatWhen(cached.savedAt) };
              // 草稿基线指向磁盘旧文本：磁盘已被改过时，保存必须走 409 冲突确认，
              // 不能拿旧草稿静默盖掉助手的新内容。
              if (cached.baseHash && cached.baseHash !== hashText(text)) {
                nextHash = cached.baseHash;
                showToast('已恢复草稿；磁盘内容也变了，保存时会提示冲突', 'warn');
              }
            } else {
              clearDraftCache(sessionId, path);
            }
          } else if (cached) {
            clearDraftCache(sessionId, path);
          }
          setCurrent({ path, text, hash: nextHash });
          setDraft(nextDraft);
          setDirty(nextDirty);
          setMode(nextDirty ? 'edit' : 'read');
          setRecovered(nextRecovered);
        } catch (err) {
          showToast(String((err && err.message) || err), 'error');
        } finally {
          setLoadingFile(false);
        }
      }, [busy, dirty, current, loadingFile, readFile, sessionId, showToast]);

      const goHome = useCallback(() => {
        if (busy) return;
        if (dirty) {
          if (!canConfirm()) {
            showToast('当前章节有未保存修改；草稿已保留在本地缓存，可随时回来恢复', 'warn');
            return;
          }
          if (!window.confirm('当前章节有未保存修改，确定返回作品总览吗？')) return;
        }
        if (current) clearDraftCache(sessionId, current.path);
        setCurrent(null);
        setDraft('');
        setDirty(false);
        setLint(null);
        setMode('read');
        setConflict(null);
        setRecovered(null);
      }, [busy, current, dirty, sessionId]);

      // 双链跳转：解析 [[目标]]（或 [[目标|别名]] 的目标段）为工程文件并打开。
      // 档案存在 → 直接打开；不存在 → 弹「一键建档」确认，写入最小骨架后打开。
      // 每次点击都重新解析（stats 可能过期：刚建的档案刷新 stats 后才进树）。
      const openWikiLink = useCallback(async (target) => {
        const resolved = resolveWikiLink(target, statsRef.current);
        if (!resolved) {
          showToast(`无法解析双链「${target}」`, 'error');
          return;
        }
        const known = statsRef.current && (() => {
          const parts = resolved.split('/');
          if (parts.length === 1) return Boolean(statsRef.current.special);
          const dir = parts[0];
          const name = parts[parts.length - 1];
          if (dir === '正文') return ((statsRef.current.chapters || []).some((c) => c.file === name));
          return ((statsRef.current.tree && statsRef.current.tree[dir]) || []).some((f) => f === name);
        })();
        if (known) {
          openFile(resolved);
          return;
        }
        // 未建档：确认后写最小骨架（走工作台保存通道，带冲突保护）
        if (busy || loadingFile) return;
        if (!canConfirm()) {
          showToast(`「${target}」还没有对应档案；当前宿主不支持确认弹窗，请从左侧导航手动建档`, 'warn');
          return;
        }
        if (!window.confirm(`「${target}」还没有对应档案（${resolved}）。现在创建一份待补全的骨架吗？`)) return;
        setBusy('wiki');
        try {
          const parts = resolved.split('/');
          const dir = parts.length > 1 ? parts[0] : '';
          const name = parts[parts.length - 1].replace(/\.md$/, '');
          const body = wikiSkeleton(dir, name);
          const data = await api('save', { path: resolved, content: body, history: false });
          setCurrent({ path: data.path, text: body, hash: data.hash || hashText(body) });
          setDraft(body);
          setDirty(false);
          setMode('edit');
          setLint(data.lint);
          showToast(`已创建 ${resolved}；骨架待补全`, 'ok');
          await refresh();
        } catch (err) {
          if (err && err.code === 'conflict') {
            showToast(`「${target}」刚被其他操作创建，正在打开现有内容`, 'warn');
            openFile(resolved, { force: true });
          } else {
            showToast(String((err && err.message) || err), 'error');
          }
        } finally {
          setBusy('');
        }
      }, [api, busy, loadingFile, openFile, refresh, showToast]);

      const save = useCallback(async (options = {}) => {
        const force = Boolean(options && options.force);
        if (!current || (!dirty && !force) || busy) return;
        const textToSave = draft;
        setBusy('save');
        try {
          const payload = { path: current.path, content: textToSave, baseHash: current.hash, history: !options.auto };
          if (force) payload.force = true;
          const data = await api('save', payload);
          setCurrent({ path: data.path, text: textToSave, hash: data.hash || hashText(textToSave) });
          // 保存期间用户继续输入时，不能把新草稿误标为已保存
          const stillDirty = draftRef.current !== textToSave;
          setDirty(stillDirty);
          setLint(data.lint);
          setConflict(null);
          setRecovered(null);
          clearDraftCache(sessionId, data.path || current.path);
          if (stillDirty) {
            saveDraftCache(sessionId, data.path || current.path, draftRef.current, data.hash || hashText(textToSave));
          }
          await refresh();
          if (data.historyWarning) {
            showToast(`已保存，但历史快照失败：${data.historyWarning}`, 'warn');
          } else if (options && options.auto) {
            showToast('已自动保存', 'ok');
          } else {
            showToast(data.lint.hardCount > 0
              ? `已保存，但仍有 ${data.lint.hardCount} 项硬违规`
              : '已保存，检查通过', data.lint.hardCount > 0 ? 'warn' : 'ok');
          }
        } catch (err) {
          if (err && err.code === 'conflict') {
            setConflict({ path: current.path, message: String(err.message || '文件已被外部修改') });
          } else {
            showToast(String((err && err.message) || err), 'error');
          }
        } finally {
          setBusy('');
        }
      }, [api, busy, current, dirty, draft, refresh, sessionId, showToast]);

      useEffect(() => { draftRef.current = draft; }, [draft]);

      useEffect(() => { saveRef.current = save; }, [save]);

      const check = useCallback(async () => {
        if (!current || busy) return;
        setBusy('lint');
        try {
          const data = await api('lint', { text: draft });
          setLint(data);
          showToast(data.hardCount > 0 ? `${data.hardCount} 项硬违规，${data.softCount} 项建议` : '没有硬违规', data.hardCount > 0 ? 'warn' : 'ok');
        } catch (err) {
          showToast(String((err && err.message) || err), 'error');
        } finally {
          setBusy('');
        }
      }, [api, busy, current, draft, showToast]);

      const createChapter = useCallback(async () => {
        if (busy) return;
        if (dirty) {
          if (!canConfirm()) {
            showToast('当前章节有未保存修改；先保存或等宿主支持确认弹窗后再新建章节', 'warn');
            return;
          }
          if (!window.confirm('当前章节有未保存修改，确定放弃并新建章节吗？')) return;
        }
        if (current) clearDraftCache(sessionId, current.path);
        setBusy('chapter');
        try {
          const number = newNumber.trim() ? Number(newNumber.trim()) : undefined;
          const data = await api('new-chapter', { title: newTitle.trim(), number });
          setShowNew(false);
          setNewTitle('');
          setNewNumber('');
          await refresh();
          await openFile(data.path, { force: true });
          showToast(`已新建第 ${data.number} 章`, 'ok');
        } catch (err) {
          showToast(String((err && err.message) || err), 'error');
        } finally {
          setBusy('');
        }
      }, [api, busy, current, dirty, newNumber, newTitle, openFile, refresh, sessionId, showToast]);

      const createProject = useCallback(async () => {
        if (busy) return;
        setBusy('project');
        try {
          const data = await api('scaffold', { title: projectTitle.trim() });
          setStats(data.stats);
          setProjectTitle('');
          showToast('作品工程已建立：可以开始建章节了', 'ok');
        } catch (err) {
          if (err && err.code === 'already-initialized') {
            showToast('当前工作区已有作品工程，已跳过初始化，未覆盖任何文件', 'warn');
          } else {
            showToast(String((err && err.message) || err), 'error');
          }
        } finally {
          setBusy('');
        }
      }, [api, busy, projectTitle, showToast]);

      const buildIndex = useCallback(async () => {
        if (busy) return;
        setBusy('index');
        try {
          const data = await api('index', { title: stats && stats.title ? stats.title : '' });
          setStats(data.stats);
          showToast(data.summary, 'ok');
        } catch (err) {
          showToast(String((err && err.message) || err), 'error');
        } finally {
          setBusy('');
        }
      }, [api, busy, showToast, stats]);

      const download = (parts, filename, mime) => {
        const blob = new Blob([parts.join('\n')], { type: `${mime};charset=utf-8` });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      };

      // 导出的共享读取循环：逐章读正文，单章失败记入 missing 不阻断其余章节。
      // Markdown 与 TXT 两种导出复用同一份容错逻辑。
      const readAllChapters = useCallback(async () => {
        const title = stats.title || '未命名作品';
        const parts = [`# ${title}`, '', `> 由 DSH-Creator 创作工作台导出 · ${stats.chapters.length} 章`, ''];
        const missing = [];
        for (const row of stats.chapters) {
          try {
            const text = await readFile(`正文/${row.file}`);
            parts.push(`\n\n---\n\n${String(text || '').trim()}`);
          } catch (err) {
            missing.push(row.file);
          }
        }
        return { title, parts, missing };
      }, [readFile, stats]);

      const exportBook = useCallback(async () => {
        if (!stats || busy) return;
        if (!stats.chapters.length) { showToast('还没有章节可导出', 'warn'); return; }
        setBusy('export');
        try {
          const { title, parts, missing } = await readAllChapters();
          download(parts, `${title.replace(/[\\/:*?"<>|]/g, '-')}.md`, 'text/markdown');
          showToast(missing.length
            ? `已导出 ${stats.chapters.length - missing.length} 章；${missing.length} 个文件读取失败`
            : `已导出全本：${stats.chapters.length} 章`, missing.length ? 'warn' : 'ok');
        } catch (err) {
          showToast(String((err && err.message) || err), 'error');
        } finally {
          setBusy('');
        }
      }, [busy, readAllChapters, showToast, stats]);

      // TXT 纯文本导出：网文平台投稿普遍不要 Markdown 标记。标题独立行、
      // 去格式保文字、空行分段；转换失败时回退为「去标记的降级文本」，导出优先。
      const exportTxt = useCallback(async () => {
        if (!stats || busy) return;
        if (!stats.chapters.length) { showToast('还没有章节可导出', 'warn'); return; }
        setBusy('export');
        try {
          const { title, parts, missing } = await readAllChapters();
          const converted = toPlainText(parts.join('\n'));
          const plain = converted || toPlainText(parts.filter((p) => p.trim()).join('\n'));
          download([plain], `${title.replace(/[\\/:*?"<>|]/g, '-')}.txt`, 'text/plain');
          showToast(missing.length
            ? `已导出 ${stats.chapters.length - missing.length} 章；${missing.length} 个文件读取失败`
            : `已导出 TXT 全本：${stats.chapters.length} 章`, missing.length ? 'warn' : 'ok');
        } catch (err) {
          showToast(String((err && err.message) || err), 'error');
        } finally {
          setBusy('');
        }
      }, [busy, readAllChapters, showToast, stats]);

      const runSearch = useCallback(async () => {
        const q = query.trim();
        if (!q) { setSearchResult(null); return; }
        if (q.length < 2) { setSearchResult({ query: q, total: 0, scanned: 0, truncated: false, results: [] }); return; }
        setSearching(true);
        try {
          const data = await api('search', { query: q, limit: 60 });
          setSearchResult(data);
        } catch (err) {
          showToast(String((err && err.message) || err), 'error');
        } finally {
          setSearching(false);
        }
      }, [api, query, showToast]);

      // 全书体检：游标式分批。每批返回后立刻合并渲染，几百章也只是「一批一批
      // 变多」，UI 全程可响应；scanRef.current=false 随时可停，已扫的批次保留。
      const scanRef = useRef(true);
      const runScan = useCallback(async () => {
        if (busy) return;
        scanRef.current = true;
        setScanOpen(true);
        setScanProgress('');
        if (!scanResult) setScanRows([]);
        setBusy('scan');
        try {
          let offset = scanResult ? scanResult.next : 0;
          let scanned = scanResult ? scanResult.scanned : 0;
          let hardTotal = scanResult ? scanResult.hardTotal : 0;
          let softTotal = scanResult ? scanResult.softTotal : 0;
          let clean = scanResult ? scanResult.cleanChapters : 0;
          let summary = '';
          while (offset !== null && offset !== undefined && scanRef.current) {
            const data = await api('scan', { offset, batch: 10 });
            setScanRows((rows) => [...rows, ...data.chapters]);
            scanned += data.scanned;
            hardTotal += data.hardTotal;
            softTotal += data.softTotal;
            clean += data.cleanChapters;
            setScanProgress(`已扫 ${scanned}/${data.total} 章 · 必修 ${hardTotal} · 建议 ${softTotal}`);
            setScanResult({
              next: data.next, done: data.done, scanned,
              hardTotal, softTotal, cleanChapters: clean, total: data.total,
            });
            summary = `${scanned} 章扫完：${hardTotal ? `${hardTotal} 项必修` : '没有硬违规'}，${softTotal} 项建议，${clean} 章干净`;
            offset = data.next;
          }
          if (scanRef.current) {
            showToast(summary || '没有可扫描的章节', hardTotal ? 'warn' : 'ok');
          } else {
            showToast('体检已停止；已扫章节的结果保留', 'info');
          }
        } catch (err) {
          showToast(String((err && err.message) || err), 'error');
        } finally {
          setBusy('');
        }
      }, [api, busy, scanResult, showToast]);

      const stopScan = useCallback(() => { scanRef.current = false; }, []);

      const closeScan = useCallback(() => {
        scanRef.current = false;
        setScanOpen(false);
      }, []);

      // 写作活动：只读统计，失败静默降级为空态（统计是锦上添花，不能变报错页）
      const loadActivity = useCallback(async () => {
        try {
          const data = await api('activity', { days: 14 });
          setActivity(data);
        } catch (err) { setActivity(null); }
      }, [api]);

      const openHistory = useCallback(async () => {
        if (!current || busy) return;
        setHistoryOpen(true);
        setHistoryList([]);
        setHistoryLoading(true);
        try {
          const data = await api('history', { path: current.path });
          setHistoryList(data.snapshots || []);
        } catch (err) {
          showToast(String((err && err.message) || err), 'error');
        } finally {
          setHistoryLoading(false);
        }
      }, [api, busy, current, showToast]);

      const restoreSnapshot = useCallback(async (snap) => {
        if (!current || busy) return;
        if (dirty) {
          if (!canConfirm()) {
            showToast('当前有未保存修改；先保存后再恢复历史版本', 'warn');
            return;
          }
          if (!window.confirm('当前还有未保存修改；恢复历史版本会丢弃这些修改（磁盘当前内容会先存为快照）。继续吗？')) return;
        }
        setBusy('restore');
        try {
          const data = await api('restore', { path: current.path, snapshot: snap.name });
          setCurrent({ path: data.path, text: data.text, hash: data.hash });
          setDraft(data.text);
          setDirty(false);
          setMode('read');
          setLint(null);
          setRecovered(null);
          setHistoryOpen(false);
          clearDraftCache(sessionId, data.path || current.path);
          await refresh();
          showToast(`已恢复到 ${formatSnapshotName(snap.name)} 的版本`, 'ok');
        } catch (err) {
          if (err && err.code === 'conflict') {
            showToast('恢复失败：文件刚被其他操作修改，请刷新后重试', 'error');
          } else {
            showToast(String((err && err.message) || err), 'error');
          }
        } finally {
          setBusy('');
        }
      }, [api, busy, current, dirty, refresh, sessionId, showToast]);

      const switchAssistant = useCallback(async (id) => {
        if (!ap || typeof ap.select !== 'function' || !sessionId || busy) {
          if (!ap || typeof ap.select !== 'function') showToast('助手服务不可用：请在 Web 端打开工作台', 'error');
          return;
        }
        if (id === preset) return;
        if (dirty) {
          if (!canConfirm()) {
            showToast('当前章节有未保存修改；先保存后再切换助手', 'warn');
            return;
          }
          if (!window.confirm('当前章节有未保存修改；切换助手后它可能改写同一文件。仍要切换吗？')) return;
        }
        setBusy('preset');
        try {
          const result = await ap.select(sessionId, id);
          if (result && typeof result === 'object' && result.ok === false) {
            throw new Error((result.error && result.error.message) || '切换失败');
          }
          setPreset(id);
          const hit = ASSISTANTS.find((a) => a.id === id);
          showToast(`已切换到${hit ? hit.name : id}`, 'ok');
        } catch (err) {
          showToast(String((err && err.message) || err), 'error');
        } finally {
          setBusy('');
        }
      }, [ap, busy, dirty, preset, sessionId, showToast]);

      const copyPrompt = useCallback(async (text, label) => {
        const done = await copyText(text);
        showToast(done ? `${label}指令已复制，粘贴到下方对话框发送` : '复制失败，请手动选中文本', done ? 'ok' : 'error');
      }, [showToast]);

      // 初次加载工程数据
      useEffect(() => { refresh(); }, [refresh]);

      // 初次加载写作活动（只读统计，失败静默）
      useEffect(() => { loadActivity(); }, [loadActivity]);

      // 助手名单
      useEffect(() => {
        let alive = true;
        if (!ap || typeof ap.list !== 'function') return () => { alive = false; };
        Promise.resolve(ap.list())
          .then((raw) => {
            if (!alive) return;
            const data = unwrap(raw);
            setRoster((data && data.presets) || []);
          })
          .catch(() => {});
        return () => { alive = false; };
      }, [ap]);

      // 当前会话的助手（projectionValues.agentPreset）
      useEffect(() => {
        let unsubscribe;
        try {
          const binding = ctx.sessions && typeof ctx.sessions.binding === 'function'
            ? ctx.sessions.binding(sessionId)
            : undefined;
          const session = binding && binding.session;
          if (!session) return undefined;
          const read = () => {
            const value = session.projectionValues && session.projectionValues.agentPreset;
            if (typeof value === 'string') setPreset(value);
          };
          read();
          if (typeof session.subscribe === 'function') unsubscribe = session.subscribe(read);
        } catch (err) { /* 投影不可用时保持空状态 */ }
        return () => { try { if (unsubscribe) unsubscribe(); } catch (err) { /* noop */ } };
      }, [ctx, sessionId]);

      // Ctrl/Cmd+S 保存
      useEffect(() => {
        const onKey = (event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 's') {
            event.preventDefault();
            if (dirty) save();
          }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [dirty, save]);

      // 自动保存：仅在编辑态、有改动、没有其他操作时，停止输入 3.5 秒后落盘
      useEffect(() => {
        if (!autoSave || !dirty || busy || !current || mode !== 'edit') return undefined;
        const timer = setTimeout(() => {
          if (saveRef.current) saveRef.current({ auto: true });
        }, 3500);
        return () => clearTimeout(timer);
      }, [autoSave, dirty, draft, busy, current, mode]);

      // 崩溃恢复：输入停顿 0.8 秒就把草稿写进 localStorage；服务端保存成功后清除
      useEffect(() => {
        if (!dirty || !current || !sessionId || mode !== 'edit') return undefined;
        const timer = setTimeout(() => {
          saveDraftCache(sessionId, current.path, draft, current.hash);
        }, 800);
        return () => clearTimeout(timer);
      }, [current, draft, dirty, mode, sessionId]);

      // 浏览器关闭/切走时提示未保存，并在最后一刻同步落一份本地草稿
      useEffect(() => {
        if (!dirty || !current || !sessionId) return undefined;
        const stash = () => {
          if (mode === 'edit') saveDraftCache(sessionId, current.path, draft, current.hash);
        };
        const onBeforeUnload = (event) => {
          stash();
          event.preventDefault();
          event.returnValue = '当前章节有未保存修改';
          return event.returnValue;
        };
        const onPageHide = () => stash();
        window.addEventListener('beforeunload', onBeforeUnload);
        window.addEventListener('pagehide', onPageHide);
        return () => {
          window.removeEventListener('beforeunload', onBeforeUnload);
          window.removeEventListener('pagehide', onPageHide);
        };
      }, [current, dirty, draft, mode, sessionId]);

      const toggleAutoSave = useCallback((next) => {
        setAutoSave(next);
        try { window.localStorage.setItem('dsh-creator:autosave', next ? '1' : '0'); } catch (err) { /* noop */ }
      }, []);

      const assistants = useMemo(() => {
        return ASSISTANTS.map((item) => {
          const hit = roster.find((row) => row && row.id === item.id);
          const full = (hit && (hit.name || hit.displayName || hit.label)) || item.name;
          return { ...item, full, broken: hit && hit.broken };
        });
      }, [roster]);

      const words = useMemo(() => countWords(mode === 'edit' ? draft : (current ? current.text : '')), [current, draft, mode]);
      // 活动条形图的高度基准：窗口内最大单日新增（至少 1，避免除零）
      const maxAdded = useMemo(() => Math.max(1, ...(activity ? activity.daily.map((d) => d.added) : [1])), [activity]);
      const nextNumber = stats && stats.chapters.length ? stats.chapters[stats.chapters.length - 1].num + 1 : 1;
      const initialized = Boolean(stats && stats.initialized);

      const style = useMemo(() => h('style', null, `
        .cw-root { position:relative; display:flex; flex-direction:column; height:100%; min-height:420px; background:var(--dsw-alias-color-bg-base, transparent); color:var(--dsw-alias-color-text-primary, inherit); font-size:13px; }
        .cw-top { display:flex; align-items:center; gap:10px; padding:8px 14px; border-bottom:1px solid var(--dsw-alias-color-border-subtle, rgba(128,128,128,.24)); flex-shrink:0; flex-wrap:wrap; }
        .cw-brand { font-weight:700; font-size:14px; letter-spacing:.02em; white-space:nowrap; }
        .cw-brand small { font-weight:400; color:var(--dsw-alias-color-text-secondary,#888); margin-left:6px; }
        .cw-tabs { display:flex; gap:2px; padding:2px; border-radius:8px; background:var(--dsw-alias-color-bg-inset,rgba(128,128,128,.1)); }
        .cw-tab { border:0; background:none; color:var(--dsw-alias-color-text-secondary,#888); padding:4px 11px; border-radius:6px; cursor:pointer; font-size:12px; }
        .cw-tab:hover:not(:disabled) { color:var(--dsw-alias-color-text-primary,inherit); }
        .cw-tab[data-on="1"] { background:var(--dsw-alias-color-bg-base,#fff); color:var(--dsw-alias-color-text-primary,inherit); font-weight:600; box-shadow:0 1px 2px rgba(0,0,0,.08); }
        .cw-tab:disabled { opacity:.45; cursor:default; }
        .cw-grow { flex:1; }
        .cw-btn { border:1px solid var(--dsw-alias-color-border-bold,rgba(128,128,128,.4)); background:var(--dsw-alias-color-bg-elevated,transparent); color:inherit; border-radius:6px; padding:3px 10px; font-size:12px; cursor:pointer; white-space:nowrap; }
        .cw-btn:hover:not(:disabled) { background:var(--dsw-alias-color-bg-hover,rgba(128,128,128,.12)); }
        .cw-btn:disabled { opacity:.45; cursor:default; }
        .cw-btn[data-pri="1"] { background:var(--dsw-alias-color-accent-emphasis,#2563eb); border-color:transparent; color:#fff; }
        .cw-btn[data-quiet="1"] { border-color:transparent; background:none; color:var(--dsw-alias-color-text-secondary,#888); }
        .cw-body { display:flex; flex:1; min-height:0; }
        .cw-nav { width:252px; min-width:210px; flex-shrink:0; overflow:auto; border-right:1px solid var(--dsw-alias-color-border-subtle,rgba(128,128,128,.24)); padding:8px; }
        .cw-nav-home { width:100%; text-align:left; border:0; background:none; color:inherit; padding:6px 8px; border-radius:6px; cursor:pointer; font-size:13px; }
        .cw-nav-home[data-on="1"] { background:var(--dsw-alias-color-bg-active,rgba(128,128,128,.16)); font-weight:600; }
        .cw-group { margin-top:6px; }
        .cw-group > summary { list-style:none; cursor:pointer; padding:5px 8px; border-radius:6px; color:var(--dsw-alias-color-text-secondary,#888); font-size:12px; display:flex; align-items:center; gap:6px; }
        .cw-group > summary:hover { background:var(--dsw-alias-color-bg-hover,rgba(128,128,128,.1)); }
        .cw-group > summary::before { content:"▸"; font-size:10px; transition:transform .12s ease; }
        .cw-group[open] > summary::before { transform:rotate(90deg); }
        .cw-group > summary b { color:var(--dsw-alias-color-text-primary,inherit); font-weight:600; }
        .cw-file { display:flex; width:100%; align-items:center; gap:8px; text-align:left; padding:4px 8px; border:0; background:none; color:inherit; border-radius:6px; cursor:pointer; font-size:12.5px; line-height:1.35; }
        .cw-file:hover { background:var(--dsw-alias-color-bg-hover,rgba(128,128,128,.12)); }
        .cw-file[data-on="1"] { background:var(--dsw-alias-color-bg-active,rgba(128,128,128,.18)); }
        .cw-file span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .cw-file em { margin-left:auto; font-style:normal; font-size:11px; color:var(--dsw-alias-color-text-secondary,#888); flex-shrink:0; }
        .cw-main { flex:1; min-width:0; display:flex; flex-direction:column; }
        .cw-bar { display:flex; align-items:center; gap:8px; padding:7px 14px; border-bottom:1px solid var(--dsw-alias-color-border-subtle,rgba(128,128,128,.24)); flex-wrap:wrap; flex-shrink:0; }
        .cw-path { font-weight:600; max-width:38%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .cw-meta { color:var(--dsw-alias-color-text-secondary,#888); font-size:12px; white-space:nowrap; }
        .cw-body-scroll { flex:1; overflow:auto; padding:26px 34px 60px; }
        .cw-article { max-width:740px; margin:0 auto; line-height:1.95; }
        .cw-chapter-title { font-size:1.32em; text-align:center; margin:1.5em 0 .95em; font-weight:700; letter-spacing:.05em; }
        .cw-heading { margin:1.35em 0 .6em; font-weight:700; font-size:1.05em; }
        .cw-p { margin:0 0 1.05em; text-indent:2em; }
        .cw-quote { color:var(--dsw-alias-color-accent-emphasis,#2563eb); }
        .cw-wikilink { color:var(--dsw-alias-color-accent-regular,#3b82f6); border-bottom:1px dashed currentColor; }
        .cw-wikilink:hover { background:var(--dsw-alias-color-bg-hover,rgba(128,128,128,.12)); }
        .cw-note { margin:0 0 1.1em; padding:6px 12px; border-left:3px solid var(--dsw-alias-color-border-bold,rgba(128,128,128,.4)); color:var(--dsw-alias-color-text-secondary,#666); text-indent:0; }
        .cw-li { margin:0 0 .55em; display:flex; gap:8px; }
        .cw-li-mark { color:var(--dsw-alias-color-text-secondary,#888); }
        .cw-hr { border:0; border-top:1px solid var(--dsw-alias-color-border-subtle,rgba(128,128,128,.3)); margin:2em auto; width:40%; }
        .cw-table { font-size:.82em; white-space:pre; overflow:auto; background:var(--dsw-alias-color-bg-inset,rgba(128,128,128,.08)); border-radius:6px; padding:10px 12px; line-height:1.6; }
        .cw-editor { width:100%; height:100%; box-sizing:border-box; border:0; outline:none; resize:none; background:transparent; color:inherit; font-family:inherit; font-size:15px; line-height:1.9; padding:26px 34px 60px; }
        .cw-empty { flex:1; display:flex; align-items:center; justify-content:center; padding:30px; }
        .cw-empty-card { max-width:520px; width:100%; }
        .cw-empty-card h2 { margin:0 0 8px; font-size:17px; }
        .cw-empty-card p { margin:0 0 16px; color:var(--dsw-alias-color-text-secondary,#888); line-height:1.7; }
        .cw-input { width:100%; box-sizing:border-box; border:1px solid var(--dsw-alias-color-border-subtle,rgba(128,128,128,.3)); background:var(--dsw-alias-color-bg-elevated,transparent); color:inherit; border-radius:6px; padding:6px 9px; font-size:13px; font-family:inherit; }
        .cw-input:focus { outline:1px solid var(--dsw-alias-color-accent-regular,#3b82f6); }
        .cw-row { display:flex; gap:8px; align-items:center; }
        .cw-row .cw-input { flex:1; min-width:0; }
        .cw-ray { width:288px; min-width:236px; flex-shrink:0; overflow:auto; border-left:1px solid var(--dsw-alias-color-border-subtle,rgba(128,128,128,.24)); padding:12px; }
        .cw-card { border:1px solid var(--dsw-alias-color-border-subtle,rgba(128,128,128,.24)); border-radius:8px; padding:10px 12px; margin-bottom:12px; background:var(--dsw-alias-color-bg-elevated,transparent); }
        .cw-card h3 { margin:0 0 8px; font-size:12px; color:var(--dsw-alias-color-text-secondary,#888); font-weight:600; letter-spacing:.04em; }
        .cw-lint-head { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px; }
        .cw-pill { border-radius:999px; padding:2px 8px; font-size:11px; }
        .cw-pill[data-tone="hard"] { background:rgba(220,38,38,.12); color:#dc2626; }
        .cw-pill[data-tone="soft"] { background:rgba(217,119,6,.12); color:#b45309; }
        .cw-pill[data-tone="ok"] { background:rgba(22,163,74,.12); color:#15803d; }
        .cw-issues { display:flex; flex-direction:column; gap:6px; max-height:360px; overflow:auto; }
        .cw-issue { display:flex; gap:7px; padding:6px; border-radius:6px; background:var(--dsw-alias-color-bg-inset,rgba(128,128,128,.06)); }
        .cw-issue-tag { flex-shrink:0; font-size:10px; line-height:1.7; padding:0 5px; border-radius:4px; height:fit-content; }
        .cw-issue-hard .cw-issue-tag { background:rgba(220,38,38,.14); color:#dc2626; }
        .cw-issue-soft .cw-issue-tag { background:rgba(217,119,6,.14); color:#b45309; }
        .cw-issue-name { font-weight:600; font-size:12px; margin-bottom:2px; }
        .cw-issue-detail { color:var(--dsw-alias-color-text-secondary,#777); font-size:11.5px; line-height:1.55; white-space:pre-wrap; }
        .cw-lint-clear { color:var(--dsw-alias-color-text-secondary,#666); font-size:12px; line-height:1.7; }
        .cw-muted { color:var(--dsw-alias-color-text-secondary,#888); font-size:12px; line-height:1.7; }
        .cw-stats { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
        .cw-stat { border-radius:6px; background:var(--dsw-alias-color-bg-inset,rgba(128,128,128,.07)); padding:7px 9px; }
        .cw-stat b { display:block; font-size:16px; line-height:1.3; }
        .cw-stat span { font-size:11px; color:var(--dsw-alias-color-text-secondary,#888); }
        .cw-actions { display:flex; flex-direction:column; gap:6px; }
        .cw-actions .cw-btn { text-align:left; }
        .cw-check { display:flex; align-items:center; gap:4px; font-size:11.5px; color:var(--dsw-alias-color-text-secondary,#888); white-space:nowrap; cursor:pointer; }
        .cw-recover { display:flex; align-items:center; gap:8px; padding:6px 14px; border-bottom:1px solid var(--dsw-alias-color-border-subtle,rgba(128,128,128,.24)); background:var(--dsw-alias-color-bg-warning,rgba(245,158,11,.12)); font-size:12px; }
        .cw-recover span { flex:1; min-width:0; }
        .cw-history-card { width:min(520px,92vw); max-height:70vh; overflow:auto; }
        .cw-history-list { margin:8px 0; border:1px solid var(--dsw-alias-color-border-subtle,rgba(128,128,128,.24)); border-radius:8px; overflow:hidden; }
        .cw-history-row { display:flex; align-items:center; gap:10px; padding:7px 10px; border-bottom:1px solid var(--dsw-alias-color-border-subtle,rgba(128,128,128,.18)); font-size:12px; }
        .cw-history-row:last-child { border-bottom:0; }
        .cw-history-time { flex:1; min-width:0; font-variant-numeric:tabular-nums; }
        .cw-history-size { color:var(--dsw-alias-color-text-secondary,#888); font-size:11px; }
        .cw-search { display:flex; gap:6px; padding:2px 4px 8px; align-items:center; }
        .cw-search .cw-input { flex:1; min-width:0; }
        .cw-search-hit { display:block; width:100%; text-align:left; border:0; background:none; color:inherit; border-radius:6px; padding:6px 8px; cursor:pointer; }
        .cw-search-hit:hover { background:var(--dsw-alias-color-bg-hover,rgba(128,128,128,.12)); }
        .cw-search-hit b { display:block; font-size:11.5px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .cw-search-hit small { display:block; color:var(--dsw-alias-color-text-secondary,#888); font-size:11px; line-height:1.5; margin-top:2px; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
        .cw-search-note { padding:2px 8px 6px; color:var(--dsw-alias-color-text-secondary,#888); font-size:11px; }
        .cw-dash { padding:26px 30px 50px; overflow:auto; }
        .cw-hero h1 { margin:0 0 6px; font-size:22px; letter-spacing:.02em; }
        .cw-hero p { margin:0 0 18px; color:var(--dsw-alias-color-text-secondary,#888); }
        .cw-cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(126px,1fr)); gap:10px; margin-bottom:20px; }
        .cw-big { border:1px solid var(--dsw-alias-color-border-subtle,rgba(128,128,128,.24)); border-radius:10px; padding:12px 14px; background:var(--dsw-alias-color-bg-elevated,transparent); }
        .cw-big span { display:block; font-size:11px; color:var(--dsw-alias-color-text-secondary,#888); margin-bottom:3px; }
        .cw-big b { font-size:19px; }
        .cw-section { margin-bottom:20px; }
        .cw-section h2 { margin:0 0 10px; font-size:14px; }
        .cw-warn { display:flex; flex-direction:column; gap:5px; }
        .cw-warn-item { font-size:12px; line-height:1.6; color:var(--dsw-alias-color-text-secondary,#666); padding:6px 9px; border-radius:6px; background:var(--dsw-alias-color-bg-inset,rgba(128,128,128,.07)); }
        .cw-warn-item b { color:var(--dsw-alias-color-text-warning,#b45309); }
        .cw-recent { display:flex; flex-direction:column; gap:2px; }
        .cw-recent .cw-file { padding:6px 8px; }
        .cw-activity { display:flex; flex-direction:column; gap:8px; }
        .cw-activity-head { display:flex; gap:6px; flex-wrap:wrap; }
        .cw-activity-bars { display:flex; gap:5px; align-items:flex-end; }
        .cw-activity-col { display:flex; flex-direction:column; align-items:center; gap:2px; width:18px; }
        .cw-activity-bar-wrap { height:48px; display:flex; align-items:flex-end; }
        .cw-activity-bar { width:10px; border-radius:3px 3px 0 0; background:var(--dsw-alias-color-accent-emphasis,#2563eb); }
        .cw-activity-day { font-size:9px; color:var(--dsw-alias-color-text-secondary,#888); }
        .cw-activity-dot { width:4px; height:4px; border-radius:50%; background:var(--dsw-alias-color-text-warning,#b45309); }
        .cw-modal { position:absolute; inset:0; z-index:30; background:rgba(0,0,0,.30); display:flex; align-items:center; justify-content:center; padding:24px; }
        .cw-modal-card { width:min(440px,100%); background:var(--dsw-alias-color-bg-base,#fff); border:1px solid var(--dsw-alias-color-border-subtle,rgba(128,128,128,.3)); border-radius:10px; padding:16px; box-shadow:0 12px 32px rgba(0,0,0,.18); }
        .cw-modal-card h3 { margin:0 0 12px; font-size:14px; }
        .cw-footer { display:flex; align-items:center; gap:10px; padding:5px 12px; border-top:1px solid var(--dsw-alias-color-border-subtle,rgba(128,128,128,.24)); font-size:11.5px; color:var(--dsw-alias-color-text-secondary,#888); flex-shrink:0; }
        .cw-toast[data-tone="ok"] { color:#15803d; }
        .cw-toast[data-tone="warn"] { color:#b45309; }
        .cw-toast[data-tone="error"] { color:#dc2626; }
        @media (max-width: 1120px) { .cw-ray { width:236px; min-width:200px; } .cw-nav { width:214px; } }
        @media (max-width: 900px) { .cw-ray { display:none; } .cw-nav { width:186px; min-width:0; } }
      `), []);

      // ---------------- 局部渲染 ----------------

      const renderFileButton = (path, label, extra) => h('button', {
        key: path,
        className: 'cw-file',
        'data-on': current && current.path === path ? '1' : undefined,
        onClick: () => openFile(path),
      }, h('span', null, label), extra ? h('em', null, extra) : null);

      const renderNav = () => {
        if (!stats) return h('div', { className: 'cw-muted', style: { padding: '10px' } }, hostError || '正在读取工程…');
        const hits = searchResult && searchResult.results ? searchResult.results : [];
        return h('div', null,
          h('div', { className: 'cw-search' },
            h('input', {
              className: 'cw-input',
              placeholder: '搜索作品（至少 2 字）',
              value: query,
              onChange: (ev) => { setQuery(ev.target.value); if (!ev.target.value.trim()) setSearchResult(null); },
              onKeyDown: (ev) => { if (ev.key === 'Enter') runSearch(); },
            }),
            h('button', { className: 'cw-btn', disabled: searching, onClick: runSearch }, searching ? '…' : '查找')),
          searchResult
            ? h('details', { className: 'cw-group', open: true },
                h('summary', null,
                  h('b', null, '搜索结果'),
                  h('span', null, `· ${searchResult.total}${searchResult.truncated ? '（已截断）' : ''}`)),
                hits.length
                  ? hits.map((hit, index) => h('button', {
                      key: `${hit.path}-${hit.line}-${index}`,
                      className: 'cw-search-hit',
                      onClick: () => openFile(hit.path),
                    },
                    h('b', null, `${fileName(hit.path)} · 第 ${hit.line} 行`),
                    h('small', null, hit.preview)))
                  : h('div', { className: 'cw-search-note' }, searchResult.query.length < 2 ? '请输入至少 2 个字。' : '没有匹配。'),
                searchResult.truncated ? h('div', { className: 'cw-search-note' }, '结果较多，只显示前 60 条；可加长关键词缩小范围。') : null)
            : null,
          h('button', {
            className: 'cw-nav-home',
            'data-on': current ? undefined : '1',
            onClick: goHome,
          }, '作品总览'),
          h('details', { className: 'cw-group', open: true },
            h('summary', null, h('b', null, '正文'), h('span', null, `· ${stats.counts.chapters}`)),
            stats.chapters.length
              ? stats.chapters.map((row) => renderFileButton(row.file, `第${String(row.num).padStart(3, '0')}章${row.title ? ` · ${row.title}` : ''}`, row.chars ? fmt(row.chars) : '空'))
              : h('div', { className: 'cw-muted', style: { padding: '4px 8px' } }, '还没有章节')),
          TREE_SECTIONS.map((section) => {
            const files = (stats.tree && stats.tree[section.dir]) || [];
            return h('details', { key: section.key, className: 'cw-group', open: files.length > 0 },
              h('summary', null, h('b', null, section.label), h('span', null, `· ${files.length}`)),
              files.length
                ? files.map((name) => renderFileButton(`${section.dir}/${name}`, name.replace(/\.md$/, '')))
                : h('div', { className: 'cw-muted', style: { padding: '4px 8px' } }, '暂无'));
          }),
          h('details', { className: 'cw-group', open: true },
            h('summary', null, h('b', null, '追踪文件')),
            SPECIAL_FILES.filter((file) => stats.special && stats.special[file.flag])
              .map((file) => renderFileButton(file.path, file.label)),
            !SPECIAL_FILES.some((file) => stats.special && stats.special[file.flag])
              ? h('div', { className: 'cw-muted', style: { padding: '4px 8px' } }, '初始化工程后生成')
              : null),
        );
      };

      const renderDashboard = () => {
        if (!stats) {
          return h('div', { className: 'cw-empty' }, h('div', { className: 'cw-empty-card' },
            h('h2', null, hostError ? '工作台宿主未就绪' : '正在读取作品工程…'),
            h('p', null, hostError || '读取工程目录与章节统计。'),
            hostError ? h('button', { className: 'cw-btn', onClick: refresh }, '重试') : null));
        }
        if (!stats.initialized) {
          return h('div', { className: 'cw-empty' }, h('div', { className: 'cw-empty-card' },
            h('h2', null, '还没有作品工程'),
            h('p', null, '工作台可以直接建工程骨架：正文、大纲、设定集、人物卡、归档、伏笔清单、时间线、文风卡，一套 Obsidian 友好的目录。也可以先和助手聊清设定，再回来建。'),
            h('div', { className: 'cw-row', style: { marginBottom: '10px' } },
              h('input', {
                className: 'cw-input',
                placeholder: '作品名，例如：长夜将至',
                value: projectTitle,
                onChange: (ev) => setProjectTitle(ev.target.value),
                onKeyDown: (ev) => { if (ev.key === 'Enter') createProject(); },
              }),
              h('button', { className: 'cw-btn', 'data-pri': '1', disabled: busy === 'project', onClick: createProject }, busy === 'project' ? '建立中…' : '新建工程')),
            h('p', null, '提示：安装包里自带四个助手。建好工程后，用顶部页签切换领域，再让助手按工程写。')));
        }
        const counts = stats.counts;
        const shadow = stats.foreshadow || { total: 0, open: 0, stale: [] };
        const missing = SPECIAL_FILES.filter((file) => !(stats.special && stats.special[file.flag]));
        return h('div', { className: 'cw-dash' },
          h('div', { className: 'cw-hero' },
            h('h1', null, stats.title || '未命名作品'),
            h('p', null, `${counts.chapters} 章 · ${fmt(counts.total)} 字 · 平均 ${fmt(counts.avg)} 字/章`)),
          h('div', { className: 'cw-cards' },
            h('div', { className: 'cw-big' }, h('span', null, '章节'), h('b', null, counts.chapters)),
            h('div', { className: 'cw-big' }, h('span', null, '总字数'), h('b', null, fmt(counts.total))),
            h('div', { className: 'cw-big' }, h('span', null, '平均每章'), h('b', null, fmt(counts.avg))),
            h('div', { className: 'cw-big' }, h('span', null, '未回收伏笔'), h('b', null, shadow.open))),
          (shadow.stale.length || counts.short || counts.empty || missing.length)
            ? h('div', { className: 'cw-section' },
                h('h2', null, '需要处理'),
                h('div', { className: 'cw-warn' },
                  shadow.stale.length
                    ? h('div', { className: 'cw-warn-item' }, h('b', null, '悬空伏笔：'), shadow.stale.map((item) => `「${item.name}」已过 ${item.gap} 章`).join('；'))
                    : null,
                  counts.short ? h('div', { className: 'cw-warn-item' }, h('b', null, '偏短章节：'), `${counts.short} 章低于 2000 字，确认是有意短章还是需要补写。`) : null,
                  counts.empty ? h('div', { className: 'cw-warn-item' }, h('b', null, '空章节：'), `${counts.empty} 个章节文件还没有正文。`) : null,
                  missing.length ? h('div', { className: 'cw-warn-item' }, h('b', null, '缺少文件：'), missing.map((file) => file.label).join('、')) : null))
            : null,
          h('div', { className: 'cw-section' },
            h('h2', null, '最近写作活动'),
            activity && (activity.writingDays > 0)
              ? h('div', { className: 'cw-activity' },
                  h('div', { className: 'cw-activity-head' },
                    h('span', { className: 'cw-pill', 'data-tone': activity.streak >= 3 ? 'ok' : 'soft' }, `连续 ${activity.streak} 天`),
                    h('span', { className: 'cw-pill', 'data-tone': 'soft' }, `近 ${activity.days} 天写作 ${activity.writingDays} 天`),
                    h('span', { className: 'cw-pill', 'data-tone': 'soft' }, `保存 ${fmt(activity.daily.reduce((s, d) => s + d.saves, 0))} 次`)),
                  h('div', { className: 'cw-activity-bars' },
                    activity.daily.map((d) => h('div', { key: d.key, className: 'cw-activity-col', title: `${d.key.slice(4, 6)}-${d.key.slice(6)}：保存 ${d.saves} 次 · 新增约 ${fmt(d.added)} 字` },
                      h('div', { className: 'cw-activity-bar-wrap' },
                        h('div', {
                          className: 'cw-activity-bar',
                          style: { height: `${Math.max(4, Math.round(Math.min(1, d.added / maxAdded) * 44))}px`, opacity: d.added ? 1 : 0.25 },
                        })),
                      h('div', { className: 'cw-activity-day' }, d.key.slice(6)),
                      d.saves ? h('div', { className: 'cw-activity-dot' }) : null)))
                  , h('div', { className: 'cw-muted', style: { marginTop: '6px' } }, '新增字数按保存前快照的体积差近似；自动保存不产生快照，不计保存次数。'))
              : h('div', { className: 'cw-muted' }, '最近 14 天还没有保存记录。写完一章用 Ctrl/Cmd+S 保存，这里会出现每日新增与连续天数。')),
          h('div', { className: 'cw-section' },
            h('h2', null, '最近章节'),
            h('div', { className: 'cw-recent' },
              stats.chapters.slice(-6).reverse().map((row) => renderFileButton(row.file, `第${String(row.num).padStart(3, '0')}章${row.title ? ` · ${row.title}` : ''}`, `${fmt(row.chars)} 字`)),
              !stats.chapters.length ? h('div', { className: 'cw-muted' }, '还没有章节。用右侧「新建章节」，或让助手先写第一章。') : null)),
          h('div', { className: 'cw-section' },
            h('h2', null, '工程操作'),
            h('div', { className: 'cw-row', style: { flexWrap: 'wrap' } },
              h('button', { className: 'cw-btn', onClick: () => setShowNew(true) }, '新建章节'),
              h('button', { className: 'cw-btn', disabled: busy === 'index', onClick: buildIndex }, busy === 'index' ? '整理中…' : '整理索引'),
              h('button', { className: 'cw-btn', onClick: busy === 'scan' ? stopScan : runScan, disabled: busy && busy !== 'scan' }, busy === 'scan' ? '停止体检' : '全书体检'),
              h('button', { className: 'cw-btn', disabled: busy === 'export', onClick: exportBook }, busy === 'export' ? '导出中…' : '导出全本 Markdown'),
              h('button', { className: 'cw-btn', disabled: busy === 'export', onClick: exportTxt }, busy === 'export' ? '导出中…' : '导出 TXT'),
              h('button', { className: 'cw-btn', 'data-quiet': '1', onClick: refresh }, '刷新工程'))));
      };

      const renderReader = () => {
        if (loadingFile) return h('div', { className: 'cw-empty' }, h('div', { className: 'cw-muted' }, '正在读取章节…'));
        if (!current) return null;
        return h('div', { className: 'cw-main' },
          h('div', { className: 'cw-bar' },
            h('span', { className: 'cw-path', title: current.path }, fileName(current.path)),
            h('span', { className: 'cw-meta' }, `${fmt(words)} 字`),
            h('span', { className: 'cw-grow' }),
            h('button', { className: 'cw-btn', onClick: () => setMode(mode === 'read' ? 'edit' : 'read') }, mode === 'read' ? '编辑' : '阅读'),
            h('button', { className: 'cw-btn', disabled: busy === 'lint', onClick: check }, busy === 'lint' ? '检查中…' : '检查'),
            h('button', { className: 'cw-btn', 'data-quiet': '1', onClick: openHistory }, '历史'),
            h('button', {
              className: 'cw-btn',
              'data-pri': dirty ? '1' : undefined,
              disabled: !dirty || busy === 'save',
              onClick: () => save(),
            }, busy === 'save' ? '保存中…' : dirty ? '保存' : '已保存'),
            h('label', {
              className: 'cw-check',
              title: '停止输入 3.5 秒后自动保存；保存前会检测文件是否被助手或其他窗口修改',
            },
            h('input', {
              type: 'checkbox',
              checked: autoSave,
              onChange: (ev) => toggleAutoSave(ev.target.checked),
            }), '自动保存'),
            h('span', { className: 'cw-meta' }, '字号'),
            h('input', {
              type: 'range', min: 14, max: 24, value: fontSize,
              onChange: (ev) => setFontSize(Number(ev.target.value)),
              style: { width: '74px' },
            })),
          recovered ? h('div', { className: 'cw-recover' },
            h('span', null, `已恢复 ${recovered.when} 的本地草稿；保存时会先检测磁盘是否被改动。`),
            h('button', {
              className: 'cw-btn',
              'data-quiet': '1',
              onClick: () => { setRecovered(null); openFile(current.path, { force: true }); },
            }, '改用磁盘版本')) : null,
          h('div', { className: 'cw-body-scroll', style: mode === 'edit' ? { padding: '0' } : undefined },
            mode === 'edit'
              ? h('textarea', {
                  className: 'cw-editor',
                  ref: editorRef,
                  value: draft,
                  spellCheck: false,
                  onChange: (ev) => { setDraft(ev.target.value); setDirty(ev.target.value !== current.text); },
                })
              : h(NovelDoc, { text: current.text, fontSize, onOpenLink: openWikiLink })));
      };

      const renderRail = () => {
        const counts = stats ? stats.counts : null;
        return h('div', { className: 'cw-ray' },
          h('div', { className: 'cw-card' },
            h('h3', null, '正文检查'),
            lint ? h('div', { className: 'cw-lint-head' },
              h('span', { className: 'cw-pill', 'data-tone': lint.hardCount ? 'hard' : 'ok' }, `必修 ${lint.hardCount}`),
              h('span', { className: 'cw-pill', 'data-tone': 'soft' }, `建议 ${lint.softCount}`)) : null,
            h(LintList, { lint })),
          h('div', { className: 'cw-card' },
            h('h3', null, '工程进度'),
            counts
              ? h('div', { className: 'cw-stats' },
                  h('div', { className: 'cw-stat' }, h('b', null, counts.chapters), h('span', null, '章节')),
                  h('div', { className: 'cw-stat' }, h('b', null, fmt(counts.total)), h('span', null, '总字数')),
                  h('div', { className: 'cw-stat' }, h('b', null, stats.foreshadow ? stats.foreshadow.open : 0), h('span', null, '未回收伏笔')),
                  h('div', { className: 'cw-stat' }, h('b', null, stats.tree ? stats.tree['人物卡'].length : 0), h('span', null, '人物卡')))
              : h('div', { className: 'cw-muted' }, '读取工程后显示。')),
          h('div', { className: 'cw-card' },
            h('h3', null, '交给助手'),
            h('div', { className: 'cw-actions' },
              h('button', {
                className: 'cw-btn',
                onClick: () => copyPrompt(
                  `请用 creator_briefing 组装写前材料（chapter_number: ${nextNumber}），然后亲自写第 ${nextNumber} 章，写完跑 creator_lint 清零硬违规，再用 creator_project 保存并归档。`,
                  '写下一章'),
              }, `写第 ${nextNumber} 章`),
              h('button', {
                className: 'cw-btn',
                onClick: () => copyPrompt(
                  current
                    ? `请检查并修复当前章节 ${current.path} 的硬违规。先读文件，再按 creator_lint 的清单逐句修，修完用 creator_lint 复查。`
                    : '请先读最近一章，再按 creator_lint 的铁律检查它的硬违规并修复。',
                  '修本章'),
              }, '修本章硬违规'),
              h('button', {
                className: 'cw-btn',
                onClick: () => copyPrompt('请用 creator_scan_book 汇总全书材料，按六个维度做体检：人物一致性、时间线、设定冲突、战力体系、伏笔遗忘、跨章重复。', '全书体检'),
              }, '全书体检'),
              h('button', {
                className: 'cw-btn',
                onClick: () => copyPrompt(
                  current
                    ? `请按《novel-project》的归档格式，从 ${current.path} 提取伏笔清单更新、时间线行和归档记录，交给 creator_archive 落盘，并回填人物卡。`
                    : '请按《novel-project》的归档格式，从最近一章提取伏笔清单更新、时间线行和归档记录，交给 creator_archive 落盘。',
                  '本章归档'),
              }, '补本章归档')),
            h('div', { className: 'cw-muted', style: { marginTop: '8px' } }, '复制后粘贴到对话框发送；助手会按工程流程执行。')),
        );
      };

      const newChapterForm = () => {
        return h('div', null,
          h('h3', null, `新建第 ${newNumber.trim() || nextNumber} 章`),
          h('div', { className: 'cw-row', style: { marginBottom: '8px' } },
            h('input', {
              className: 'cw-input', placeholder: '章号（留空则自动续号）', value: newNumber,
              onChange: (ev) => setNewNumber(ev.target.value.replace(/[^\d]/g, '')),
            }),
            h('input', {
              className: 'cw-input', placeholder: '章节标题（可留空）', value: newTitle,
              onChange: (ev) => setNewTitle(ev.target.value),
            })),
          h('div', { className: 'cw-row' },
            h('button', { className: 'cw-btn', 'data-pri': '1', disabled: busy === 'chapter', onClick: createChapter }, busy === 'chapter' ? '创建中…' : '创建'),
            h('button', { className: 'cw-btn', 'data-quiet': '1', onClick: () => setShowNew(false) }, '取消')));
      };

      return h('div', { className: 'cw-root' },
        style,
        h('div', { className: 'cw-top' },
          h('div', { className: 'cw-brand' }, '创作工作台', h('small', null, 'DSH-Creator')),
          h('div', { className: 'cw-tabs', role: 'tablist' },
            assistants.map((item) => h('button', {
              key: item.id,
              className: 'cw-tab',
              role: 'tab',
              title: item.broken ? `${item.full}（当前不可用）` : item.full,
              'data-on': preset === item.id ? '1' : undefined,
              disabled: busy === 'preset' || Boolean(item.broken),
              onClick: () => switchAssistant(item.id),
            }, item.label))),
          h('span', { className: 'cw-grow' }),
          stats && stats.title ? h('span', { className: 'cw-meta', style: { maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis' } }, stats.title) : null,
          hostError && stats ? h('span', { className: 'cw-toast', 'data-tone': 'error', title: hostError }, '宿主同步失败') : null,
          h('button', { className: 'cw-btn', onClick: refresh }, '刷新')),
        hostError && !stats
          ? h('div', { className: 'cw-empty' }, h('div', { className: 'cw-empty-card' },
              h('h2', null, '工作台宿主未就绪'),
              h('p', null, hostError),
              h('p', null, '工作台需要在 Web 端使用，并且插件已正确安装。若刚安装插件，请重启 DSH 后再打开本视图。'),
              h('button', { className: 'cw-btn', onClick: refresh }, '重试')))
          : h('div', { className: 'cw-body' },
              h('div', { className: 'cw-nav' }, renderNav()),
              current ? renderReader() : h('div', { className: 'cw-main' }, renderDashboard()),
              renderRail()),
        showNew ? h('div', { className: 'cw-modal', onClick: (ev) => { if (ev.target === ev.currentTarget) setShowNew(false); } },
          h('div', { className: 'cw-modal-card' }, newChapterForm())) : null,
        conflict ? h('div', { className: 'cw-modal' },
          h('div', { className: 'cw-modal-card' },
            h('h3', null, '文件已被外部修改'),
            h('p', { className: 'cw-muted' }, conflict.path),
            h('p', { className: 'cw-muted' }, conflict.message),
            h('p', { className: 'cw-muted' }, '「重新加载」会放弃你当前的修改并使用磁盘上的新版本；「覆盖保存」会用当前编辑内容覆盖磁盘版本。'),
            h('div', { className: 'cw-row' },
              h('button', {
                className: 'cw-btn',
                'data-pri': '1',
                onClick: () => { const path = conflict.path; setConflict(null); openFile(path, { force: true }); },
              }, '重新加载'),
              h('button', {
                className: 'cw-btn',
                onClick: () => { setConflict(null); save({ force: true }); },
              }, '覆盖保存'),
              h('button', {
                className: 'cw-btn',
                'data-quiet': '1',
                onClick: () => setConflict(null),
              }, '取消')))) : null,
        historyOpen ? h('div', { className: 'cw-modal', onClick: (ev) => { if (ev.target === ev.currentTarget) setHistoryOpen(false); } },
          h('div', { className: 'cw-modal-card cw-history-card' },
            h('h3', null, '历史版本'),
            h('p', { className: 'cw-muted' }, current ? current.path : ''),
            h('p', { className: 'cw-muted' }, '每次手工保存都会把保存前的磁盘内容存成快照；自动保存不生成快照。恢复前会先把当前磁盘内容再存一份。'),
            historyLoading
              ? h('div', { className: 'cw-muted' }, '正在读取快照…')
              : historyList.length
                ? h('div', { className: 'cw-history-list' },
                    historyList.map((snap) => h('div', { className: 'cw-history-row', key: snap.name },
                      h('span', { className: 'cw-history-time' }, formatSnapshotName(snap.name)),
                      h('span', { className: 'cw-history-size' }, snap.size ? `${Math.max(1, Math.round(snap.size / 1024))} KB` : ''),
                      h('button', {
                        className: 'cw-btn',
                        disabled: busy === 'restore',
                        onClick: () => restoreSnapshot(snap),
                      }, '恢复'))))
                : h('p', { className: 'cw-muted' }, '还没有历史版本。做一次手工保存后再来看看。'),
            h('div', { className: 'cw-row' },
              h('button', { className: 'cw-btn', 'data-quiet': '1', onClick: () => setHistoryOpen(false) }, '关闭')))) : null,
        scanOpen ? h('div', { className: 'cw-modal', onClick: (ev) => { if (ev.target === ev.currentTarget) closeScan(); } },
          h('div', { className: 'cw-modal-card cw-history-card' },
            h('h3', null, '全书体检'),
            h('p', { className: 'cw-muted' }, '逐章跑正文检查引擎，按章汇总硬违规与建议项；分批进行，可随时停止，已扫结果保留。'),
            h('p', { className: 'cw-muted' }, scanProgress || '点「开始体检」从第一章扫起。'),
            scanRows.length
              ? h('div', { className: 'cw-history-list' },
                  scanRows.filter((row) => row.hardCount > 0 || row.softCount > 0).length === 0 && (scanResult && scanResult.done)
                    ? h('div', { className: 'cw-history-row' }, h('span', { className: 'cw-history-time' }, '全部章节干净，没有可量化的违规。'))
                    : scanRows.filter((row) => row.hardCount > 0 || row.softCount > 0).map((row) => h('div', { className: 'cw-history-row', key: row.file, style: { flexWrap: 'wrap' } },
                        h('button', {
                          className: 'cw-search-hit',
                          style: { flex: '0 0 auto', minWidth: '148px' },
                          title: row.file,
                          onClick: () => { closeScan(); openFile(`正文/${row.file}`); },
                        },
                        h('b', null, `第${String(row.num).padStart(3, '0')}章`),
                        h('small', null, `${fmt(row.chars)} 字`)),
                        h('span', { className: 'cw-lint-head', style: { flex: 1, minHeight: '24px' } },
                          row.hardCount ? h('span', { className: 'cw-pill', 'data-tone': 'hard' }, `必修 ${row.hardCount}`) : null,
                          row.softCount ? h('span', { className: 'cw-pill', 'data-tone': 'soft' }, `建议 ${row.softCount}`) : null),
                        h('span', { className: 'cw-issue-detail', style: { flexBasis: '100%' } },
                          row.hard.concat(row.soft).map((i) => `${i.name}`).join('；')))))
              : null,
            h('div', { className: 'cw-row' },
              busy === 'scan'
                ? h('button', { className: 'cw-btn', onClick: stopScan }, '停止')
                : h('button', { className: 'cw-btn', 'data-pri': '1', onClick: runScan },
                    scanResult && scanResult.next !== null ? '继续体检（接着上次）' : '开始体检'),
              h('button', { className: 'cw-btn', 'data-quiet': '1', onClick: closeScan }, '关闭')))) : null,
        h('div', { className: 'cw-footer' },
          h('span', { className: 'cw-meta' }, current ? current.path : (stats && stats.initialized ? '作品总览' : '未初始化')),
          h('span', { className: 'cw-grow' }),
          toast ? h('span', { className: 'cw-toast', 'data-tone': toast.tone }, toast.text) : null));
    }

    // 渲染期错误边界：React.Component 可用时用 class 边界（能捕获渲染异常并显示
    // 真实报错，而不是让宿主把整个视图吞成空白）；Component 不可用时退化为透传。
    let StudioBoundary;
    if (typeof React.Component === 'function') {
      StudioBoundary = class extends React.Component {
        constructor(props) { super(props); this.state = { error: null }; }
        static getDerivedStateFromError(error) { return { error }; }
        componentDidCatch(error, info) {
          try { console.error('[creator-workbench] render crash:', error, info && info.componentStack); } catch (err) { /* noop */ }
        }
        render() {
          const err = this.state.error;
          if (!err) return this.props.children;
          return h('div', { className: 'cw-root', style: { padding: '28px' } },
            h('div', { style: { maxWidth: '640px' } },
              h('h2', null, '工作台渲染出错'),
              h('p', null, '把下面的报错发给 Agent 即可定位修复：'),
              h('pre', { style: { whiteSpace: 'pre-wrap', background: 'rgba(128,128,128,.12)', padding: '12px', borderRadius: '8px', fontSize: '12px', lineHeight: 1.6 } },
                String((err && err.stack) || err)),
              h('button', { className: 'cw-btn', onClick: () => this.setState({ error: null }) }, '重试')));
        }
      };
    } else {
      StudioBoundary = ({ children }) => children;
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        if (ctx.slots) {
          ctx.slots.inject('conversation.view', () => ctx.slots.register({
            name: 'conversation.view',
            id: 'creator-workbench',
            order: 30,
            label: () => '创作工作台',
          }, (props) => h(StudioBoundary, null, h(StudioView, { ctx, sessionId: props && props.sessionId }))));
        }
      },
    };
  },
});
