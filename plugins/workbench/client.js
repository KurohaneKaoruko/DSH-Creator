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
    const { useState, useEffect, useMemo, useRef, useCallback } = React;
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
        throw new Error((data.error && data.error.message) || `请求失败（HTTP ${res.status}）`);
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

    function renderInline(text, prefix) {
      const out = [];
      let last = 0;
      let index = 0;
      const source = String(text || '');
      source.replace(INLINE_RE, (match, token, offset) => {
        if (offset > last) out.push(source.slice(last, offset));
        if (token.startsWith('**')) {
          out.push(h('strong', { key: `${prefix}-b${index++}` }, token.slice(2, -2)));
        } else if (token.startsWith('[[')) {
          out.push(h('span', { key: `${prefix}-w${index++}`, className: 'cw-wikilink' }, token.slice(2, -2)));
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

    function renderDocument(text, keyPrefix) {
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
          blocks.push(h('blockquote', { key, className: 'cw-note' }, renderInline(line.slice(2), key)));
          continue;
        }
        const li = line.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
        if (li) {
          blocks.push(h('div', { key, className: 'cw-li' }, h('span', { className: 'cw-li-mark' }, '·'), renderInline(li[1], key)));
          continue;
        }
        blocks.push(h('p', { key, className: 'cw-p' }, renderInline(line, key)));
      }
      flushTable();
      return blocks;
    }

    function NovelDoc({ text, fontSize }) {
      const blocks = useMemo(() => renderDocument(text, 'doc'), [text]);
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

      const toastTimer = useRef(null);
      const editorRef = useRef(null);
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

      const openFile = useCallback(async (path) => {
        setLoadingFile(true);
        setLint(null);
        try {
          const text = await readFile(path);
          setCurrent({ path, text });
          setDraft(text);
          setDirty(false);
          setMode('read');
        } catch (err) {
          showToast(String((err && err.message) || err), 'error');
        } finally {
          setLoadingFile(false);
        }
      }, [readFile, showToast]);

      const save = useCallback(async () => {
        if (!current || !dirty || busy) return;
        setBusy('save');
        try {
          const data = await api('save', { path: current.path, content: draft });
          setCurrent({ path: data.path, text: draft });
          setDirty(false);
          setLint(data.lint);
          await refresh();
          showToast(data.lint.hardCount > 0
            ? `已保存，但仍有 ${data.lint.hardCount} 项硬违规`
            : '已保存，检查通过', data.lint.hardCount > 0 ? 'warn' : 'ok');
        } catch (err) {
          showToast(String((err && err.message) || err), 'error');
        } finally {
          setBusy('');
        }
      }, [api, busy, current, dirty, draft, refresh, showToast]);

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
        setBusy('chapter');
        try {
          const number = newNumber.trim() ? Number(newNumber.trim()) : undefined;
          const data = await api('new-chapter', { title: newTitle.trim(), number });
          setShowNew(false);
          setNewTitle('');
          setNewNumber('');
          await refresh();
          await openFile(data.path);
          showToast(`已新建第 ${data.number} 章`, 'ok');
        } catch (err) {
          showToast(String((err && err.message) || err), 'error');
        } finally {
          setBusy('');
        }
      }, [api, busy, newNumber, newTitle, openFile, refresh, showToast]);

      const createProject = useCallback(async () => {
        if (busy) return;
        setBusy('project');
        try {
          const data = await api('scaffold', { title: projectTitle.trim() });
          setStats(data.stats);
          setProjectTitle('');
          showToast('作品工程已建立：可以开始建章节了', 'ok');
        } catch (err) {
          showToast(String((err && err.message) || err), 'error');
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

      const switchAssistant = useCallback(async (id) => {
        if (!ap || typeof ap.select !== 'function' || !sessionId || busy) {
          if (!ap || typeof ap.select !== 'function') showToast('助手服务不可用：请在 Web 端打开工作台', 'error');
          return;
        }
        if (id === preset) return;
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
      }, [ap, busy, preset, sessionId, showToast]);

      const copyPrompt = useCallback(async (text, label) => {
        const done = await copyText(text);
        showToast(done ? `${label}指令已复制，粘贴到下方对话框发送` : '复制失败，请手动选中文本', done ? 'ok' : 'error');
      }, [showToast]);

      // 初次加载工程数据
      useEffect(() => { refresh(); }, [refresh]);

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

      const assistants = useMemo(() => {
        return ASSISTANTS.map((item) => {
          const hit = roster.find((row) => row && row.id === item.id);
          const full = (hit && (hit.name || hit.displayName || hit.label)) || item.name;
          return { ...item, full, broken: hit && hit.broken };
        });
      }, [roster]);

      const words = useMemo(() => countWords(mode === 'edit' ? draft : (current ? current.text : '')), [current, draft, mode]);
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
        return h('div', null,
          h('button', {
            className: 'cw-nav-home',
            'data-on': current ? undefined : '1',
            onClick: () => { setCurrent(null); setLint(null); setMode('read'); },
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
            h('h2', null, '最近章节'),
            h('div', { className: 'cw-recent' },
              stats.chapters.slice(-6).reverse().map((row) => renderFileButton(row.file, `第${String(row.num).padStart(3, '0')}章${row.title ? ` · ${row.title}` : ''}`, `${fmt(row.chars)} 字`)),
              !stats.chapters.length ? h('div', { className: 'cw-muted' }, '还没有章节。用右侧「新建章节」，或让助手先写第一章。') : null)),
          h('div', { className: 'cw-section' },
            h('h2', null, '工程操作'),
            h('div', { className: 'cw-row', style: { flexWrap: 'wrap' } },
              h('button', { className: 'cw-btn', onClick: () => setShowNew(true) }, '新建章节'),
              h('button', { className: 'cw-btn', disabled: busy === 'index', onClick: buildIndex }, busy === 'index' ? '整理中…' : '整理索引'),
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
            h('button', {
              className: 'cw-btn',
              'data-pri': dirty ? '1' : undefined,
              disabled: !dirty || busy === 'save',
              onClick: save,
            }, busy === 'save' ? '保存中…' : dirty ? '保存' : '已保存'),
            h('span', { className: 'cw-meta' }, '字号'),
            h('input', {
              type: 'range', min: 14, max: 24, value: fontSize,
              onChange: (ev) => setFontSize(Number(ev.target.value)),
              style: { width: '74px' },
            })),
          h('div', { className: 'cw-body-scroll', style: mode === 'edit' ? { padding: '0' } : undefined },
            mode === 'edit'
              ? h('textarea', {
                  className: 'cw-editor',
                  ref: editorRef,
                  value: draft,
                  spellCheck: false,
                  onChange: (ev) => { setDraft(ev.target.value); setDirty(ev.target.value !== current.text); },
                })
              : h(NovelDoc, { text: current.text, fontSize })));
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
        h('div', { className: 'cw-footer' },
          h('span', { className: 'cw-meta' }, current ? current.path : (stats && stats.initialized ? '作品总览' : '未初始化')),
          h('span', { className: 'cw-grow' }),
          toast ? h('span', { className: 'cw-toast', 'data-tone': toast.tone }, toast.text) : null));
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
          }, (props) => h(StudioView, { ctx, sessionId: props && props.sessionId })));
        }
      },
    };
  },
});
