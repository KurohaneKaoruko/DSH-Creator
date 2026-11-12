// Client half of dsh-novel-editor.
//
// 创作工作台（Creator Studio）：整页视图注册在 conversation.view 槽（会话头部
// 视图切换器）。布局：顶部领域页签（从 agentPresets roster 拉取本 bundle 声明
// 的领域预设，点击即切换会话预设），下方左中右三栏——左侧章节文件列表，
// 中间阅读/编辑双栏（列表与正文并排），底部状态条。
//
// File IO:
//   - reads:  ctx.remote.workspaceFiles.read/list (official Remote channel);
//   - writes: POST /novel-editor/v1/api/save (Host half owns the route).
//
// Styling uses only --dsw-alias-* theme tokens.

window.__ModuleLoader__.load({
  id: 'dsh-novel-editor',
  factory(require) {
    const React = require('react');
    const { useState, useEffect, useMemo, useRef, useCallback } = React;
    const h = React.createElement;

    // ---------------- utilities ----------------

    const CH_RE = /^(第[零〇一二两三四五六七八九十百千0-9]+[章回节集][^\n]*)$/;

    function parseChapters(text) {
      const lines = text.split('\n');
      const chapters = [];
      let cur = null;
      for (const line of lines) {
        const m = line.trim().match(CH_RE);
        if (m) {
          cur = { title: m[1], body: [] };
          chapters.push(cur);
        } else if (cur) {
          cur.body.push(line);
        } else if (line.trim()) {
          if (!chapters.length) chapters.push({ title: '', body: [] });
          chapters[0].body.push(line);
        }
      }
      return chapters;
    }

    function countWords(text) {
      const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
      const latin = (text.match(/[a-zA-Z]+/g) || []).length;
      return cjk + latin;
    }

    // minimal markdown → React elements (novel-optimized, no deps)
    function renderMarkdown(text, keyPrefix) {
      const out = [];
      const paras = text.split(/\n{2,}/);
      let k = 0;
      const inlinePlain = (str, pk) => {
        const parts = [];
        let s = str;
        let pi = 0;
        while (s.length) {
          const m = s.match(/^([\s\S]*?)(\*\*[^*]+\*\*|\[\[[^\]]+\]\]|\*[^*\s][^*]*\*)/);
          if (!m) { parts.push(s); break; }
          if (m[1]) parts.push(m[1]);
          const token = m[2];
          if (token.startsWith('**')) {
            parts.push(h('strong', { key: `${pk}-b-${pi++}` }, token.slice(2, -2)));
          } else if (token.startsWith('[[')) {
            parts.push(h('span', { key: `${pk}-w-${pi++}`, className: 'nvr-wikilink' }, token.slice(2, -2)));
          } else {
            parts.push(h('em', { key: `${pk}-i-${pi++}` }, token.slice(1, -1)));
          }
          s = s.slice(m[0].length);
        }
        return parts;
      };
      const inline = (str, pk) => {
        const parts = [];
        let s = str;
        let i = 0;
        while (s.length) {
          const bq = s.indexOf('“');
          if (bq >= 0) {
            const eq = s.indexOf('”', bq + 1);
            if (eq > bq) {
              if (bq > 0) parts.push(...inlinePlain(s.slice(0, bq), `${pk}-${i++}`));
              parts.push(h('span', { key: `${pk}-q-${i++}`, className: 'nvr-quote' }, s.slice(bq, eq + 1)));
              s = s.slice(eq + 1);
              continue;
            }
          }
          parts.push(...inlinePlain(s, `${pk}-${i++}`));
          break;
        }
        return parts;
      };
      for (const para of paras) {
        const t = para.trim();
        if (!t) continue;
        k += 1;
        if (CH_RE.test(t)) {
          out.push(h('h2', { key: `${keyPrefix}-h-${k}`, className: 'nvr-h2' }, t));
          continue;
        }
        if (/^#{1,6}\s/.test(t)) {
          const level = Math.min(t.match(/^#+/)[0].length + 1, 6);
          out.push(h(`h${level}`, { key: `${keyPrefix}-hh-${k}`, className: 'nvr-hh' }, t.replace(/^#+\s*/, '')));
          continue;
        }
        if (/^(-{3,}|\*{3,})$/.test(t)) {
          out.push(h('hr', { key: `${keyPrefix}-hr-${k}`, className: 'nvr-hr' }));
          continue;
        }
        if (/^\|/.test(t)) {
          out.push(h('pre', { key: `${keyPrefix}-tb-${k}`, className: 'nvr-table' }, t));
          continue;
        }
        out.push(h('p', { key: `${keyPrefix}-p-${k}`, className: 'nvr-p' }, inline(t, `${keyPrefix}-${k}`)));
      }
      return out;
    }

    // ---------------- workbench ----------------

    // 领域页签：本 bundle 声明的领域预设（id → 显示名）
    const DOMAIN_PRESETS = [
      { id: 'novelist', label: '小说' },
      { id: 'screenwriter', label: '短剧/编剧' },
      { id: 'gamescript', label: '游戏剧本' },
      { id: 'general-creator', label: '通用创作' },
    ];

    function StudioView({ ctx }) {
      const remote = ctx.remote || {};
      const wf = remote.workspaceFiles;
      const [dir, setDir] = useState('.');
      const [entries, setEntries] = useState([]);
      const [current, setCurrent] = useState(null); // { path, text }
      const [edited, setEdited] = useState('');
      const [dirty, setDirty] = useState(false);
      const [saving, setSaving] = useState(false);
      const [msg, setMsg] = useState('');
      const [mode, setMode] = useState('read'); // read | edit
      const [fontSize, setFontSize] = useState(17);
      const [activePreset, setActivePreset] = useState(null);
      const [switching, setSwitching] = useState(false);

      // 当前会话预设探测 + roster 拉取
      useEffect(() => {
        let alive = true;
        const ap = remote.agentPresets;
        if (!ap) return undefined;
        Promise.resolve(ap.list ? ap.list() : null)
          .then((roster) => { if (alive && roster) setRosterInfo(roster); })
          .catch(() => {});
        return () => { alive = false; };
      }, [remote]);

      const setRosterInfo = (roster) => {
        // roster 结构按实际返回适配：找当前会话选中预设
        try {
          const cur = roster.current || roster.selected || (roster.presets && roster.presets.find((p) => p.current));
          if (cur && cur.id) setActivePreset(cur.id);
        } catch { /* best-effort */ }
      };

      const switchPreset = useCallback(async (presetId) => {
        const ap = remote.agentPresets;
        if (!ap || !ap.select || switching) return;
        setSwitching(true);
        try {
          await ap.select(presetId);
          setActivePreset(presetId);
          setMsg('');
        } catch (err) {
          setMsg(String((err && err.message) || err));
        } finally {
          setSwitching(false);
        }
      }, [remote, switching]);

      const loadDir = useCallback(async (path) => {
        if (!wf) return;
        try {
          const listing = await wf.list(undefined, path);
          setEntries((listing && listing.entries) || []);
          setDir(path);
        } catch (err) {
          setMsg(String((err && err.message) || err));
        }
      }, [wf]);

      useEffect(() => { if (wf) loadDir('.'); }, [wf, loadDir]);

      const openFile = useCallback(async (path) => {
        if (!wf) return;
        try {
          const res = await wf.read(undefined, path);
          const text = res && (res.text != null ? res.text : res.content) || '';
          setCurrent({ path, text });
          setEdited(text);
          setDirty(false);
          setMsg('');
        } catch (err) {
          setMsg(String((err && err.message) || err));
        }
      }, [wf]);

      const enter = useCallback((e) => {
        const isDir = e.entryKind === 'directory' || e.isDirectory;
        if (isDir) loadDir((dir === '.' ? '' : dir + '/') + e.name);
        else openFile((dir === '.' ? '' : dir + '/') + e.name);
      }, [dir, loadDir, openFile]);

      const save = useCallback(async () => {
        if (!current || !dirty) return;
        setSaving(true);
        try {
          const res = await fetch('/novel-editor/v1/api/save', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: current.path, content: edited }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.ok) {
            setCurrent({ path: current.path, text: edited });
            setDirty(false);
            setMsg('');
          } else {
            setMsg((data.error && data.error.message) || `save failed (${res.status})`);
          }
        } catch (err) {
          setMsg(String((err && err.message) || err));
        } finally {
          setSaving(false);
        }
      }, [current, edited, dirty]);

      const chapters = useMemo(() => (current ? parseChapters(current.text) : []), [current]);
      const words = useMemo(() => (current ? countWords(current.text) : 0), [current]);

      const style = useMemo(() => h('style', null, `
        .nvr-root { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--dsw-alias-color-bg-base, transparent); color: var(--dsw-alias-color-text-primary, inherit); }
        .nvr-domains { display: flex; gap: 4px; padding: 6px 12px 0; border-bottom: 1px solid var(--dsw-alias-color-border-subtle, rgba(128,128,128,.25)); flex-shrink: 0; }
        .nvr-domain { border: 1px solid transparent; border-bottom: 0; background: none; color: var(--dsw-alias-color-text-secondary, #888); cursor: pointer; border-radius: 8px 8px 0 0; padding: 5px 14px; font-size: 13px; }
        .nvr-domain:hover { color: var(--dsw-alias-color-text-primary, inherit); background: var(--dsw-alias-color-bg-hover, rgba(128,128,128,.1)); }
        .nvr-domain[data-on="1"] { color: var(--dsw-alias-color-text-primary, inherit); background: var(--dsw-alias-color-bg-active, rgba(128,128,128,.16)); border-color: var(--dsw-alias-color-border-subtle, rgba(128,128,128,.25)); font-weight: 600; }
        .nvr-cols { display: flex; flex: 1; min-height: 0; }
        .nvr-side { width: 230px; min-width: 180px; overflow: auto; border-right: 1px solid var(--dsw-alias-color-border-subtle, rgba(128,128,128,.25)); padding: 10px 8px; flex-shrink: 0; }
        .nvr-side h3 { margin: 4px 8px 8px; font-size: 12px; color: var(--dsw-alias-color-text-secondary, #888); font-weight: 600; }
        .nvr-file { display: block; width: 100%; text-align: left; padding: 5px 8px; border: 0; background: none; color: inherit; cursor: pointer; border-radius: 6px; font-size: 13px; line-height: 1.4; }
        .nvr-file:hover { background: var(--dsw-alias-color-bg-hover, rgba(128,128,128,.12)); }
        .nvr-file[data-on="1"] { background: var(--dsw-alias-color-bg-active, rgba(128,128,128,.18)); font-weight: 600; }
        .nvr-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
        .nvr-bar { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--dsw-alias-color-border-subtle, rgba(128,128,128,.25)); font-size: 12px; color: var(--dsw-alias-color-text-secondary, #888); flex-wrap: wrap; }
        .nvr-bar b { color: var(--dsw-alias-color-text-primary, inherit); font-weight: 600; }
        .nvr-btn { border: 1px solid var(--dsw-alias-color-border-bold, rgba(128,128,128,.4)); background: var(--dsw-alias-color-bg-elevated, transparent); color: inherit; border-radius: 6px; padding: 3px 10px; font-size: 12px; cursor: pointer; }
        .nvr-btn:hover:not(:disabled) { background: var(--dsw-alias-color-bg-hover, rgba(128,128,128,.12)); }
        .nvr-btn:disabled { opacity: .45; cursor: default; }
        .nvr-btn[data-pri="1"] { background: var(--dsw-alias-color-accent-emphasis, #2563eb); border-color: transparent; color: #fff; }
        .nvr-msg { color: var(--dsw-alias-color-text-warning, #b45309); }
        .nvr-body { flex: 1; overflow: auto; padding: 24px 32px; }
        .nvr-article { max-width: 720px; margin: 0 auto; font-size: ${fontSize}px; line-height: 1.9; }
        .nvr-h2 { font-size: 1.35em; margin: 1.6em 0 .8em; text-align: center; font-weight: 700; letter-spacing: .04em; }
        .nvr-hh { margin: 1.4em 0 .6em; font-weight: 700; }
        .nvr-hr { border: 0; border-top: 1px solid var(--dsw-alias-color-border-subtle, rgba(128,128,128,.3)); margin: 2em auto; width: 40%; }
        .nvr-p { margin: 0 0 1.1em; text-indent: 2em; }
        .nvr-quote { color: var(--dsw-alias-color-accent-emphasis, #2563eb); }
        .nvr-wikilink { color: var(--dsw-alias-color-accent-regular, #3b82f6); border-bottom: 1px dashed currentColor; }
        .nvr-table { font-size: .85em; overflow: auto; white-space: pre; background: var(--dsw-alias-color-bg-inset, rgba(128,128,128,.08)); border-radius: 6px; padding: 8px; }
        .nvr-edit { width: 100%; height: 100%; box-sizing: border-box; border: 0; outline: none; resize: none; background: transparent; color: inherit; font-family: inherit; font-size: 15px; line-height: 1.9; padding: 24px 32px; }
        .nvr-empty { margin: auto; text-align: center; color: var(--dsw-alias-color-text-secondary, #888); }
        .nvr-empty p { margin: .4em 0; }
      `), [fontSize]);

      return h('div', { className: 'nvr-root' },
        style,
        // 领域页签
        h('div', { className: 'nvr-domains', role: 'tablist' },
          DOMAIN_PRESETS.map((d) => h('button', {
            key: d.id,
            className: 'nvr-domain',
            role: 'tab',
            'data-on': activePreset === d.id ? '1' : undefined,
            disabled: switching,
            onClick: () => switchPreset(d.id),
          }, d.label)),
        ),
        h('div', { className: 'nvr-cols' },
          // 左：章节列表
          h('div', { className: 'nvr-side' },
            h('h3', null, '章节文件'),
            entries.map((e) => h('button', {
              key: e.name,
              className: 'nvr-file',
              'data-on': current && current.path === ((dir === '.' ? '' : dir + '/') + e.name) ? '1' : undefined,
              onClick: () => enter(e),
            }, (e.entryKind === 'directory' || e.isDirectory ? '📁 ' : '📄 ') + e.name)),
          ),
          // 右：正文（阅读/编辑）
          h('div', { className: 'nvr-main' },
            h('div', { className: 'nvr-bar' },
              current ? h('b', null, current.path) : h('span', null, '未打开文件'),
              current && h('span', null, `${words} 字 · ${chapters.length || 1} 章`),
              current && h('button', { className: 'nvr-btn', onClick: () => setMode(mode === 'read' ? 'edit' : 'read') }, mode === 'read' ? '编辑' : '阅读'),
              current && mode === 'edit' && h('button', { className: 'nvr-btn', 'data-pri': dirty ? '1' : undefined, disabled: !dirty || saving, onClick: save }, saving ? '保存中…' : dirty ? '保存' : '已保存'),
              h('span', null, 'A'),
              h('input', { type: 'range', min: 14, max: 24, value: fontSize, onChange: (ev) => setFontSize(Number(ev.target.value)), style: { width: 80 } }),
              msg && h('span', { className: 'nvr-msg' }, msg),
            ),
            h('div', { className: 'nvr-body' },
              !current
                ? h('div', { className: 'nvr-empty' },
                    h('p', null, '从左侧选择一个 Markdown 章节文件'),
                    h('p', null, '顶部页签切换领域助手；正文支持阅读与编辑双模式'))
                : mode === 'read'
                  ? h('article', { className: 'nvr-article' }, renderMarkdown(current.text, 'a'))
                  : h('textarea', {
                      className: 'nvr-edit',
                      value: edited,
                      onChange: (ev) => { setEdited(ev.target.value); setDirty(ev.target.value !== current.text); },
                      spellCheck: false,
                    }),
            ),
          ),
        ),
      );
    }

    // right-sidebar document preview (novel-optimized markdown)
    function NovelDocPreview({ node }) {
      const text = node && (node.text != null ? node.text : node.content) || '';
      const words = countWords(text);
      return h('div', { className: 'nvr-doc' },
        h('style', null, `
          .nvr-doc { padding: 12px 16px; font-size: 15px; line-height: 1.85; }
          .nvr-doc .nvr-p { text-indent: 2em; margin: 0 0 1em; }
          .nvr-doc .nvr-h2 { text-align: center; font-size: 1.25em; margin: 1.2em 0 .7em; }
          .nvr-doc .nvr-quote { color: var(--dsw-alias-color-accent-emphasis, #2563eb); }
          .nvr-doc .nvr-wikilink { color: var(--dsw-alias-color-accent-regular, #3b82f6); border-bottom: 1px dashed currentColor; }
          .nvr-doc .nvr-words { font-size: 12px; color: var(--dsw-alias-color-text-secondary, #888); text-align: right; }
        `),
        h('div', { className: 'nvr-words' }, `${words} 字`),
        renderMarkdown(text, 'd'),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 创作工作台：Conversation 目标视图（官方整页座位）
        ctx.slots.inject('conversation.view', () => ctx.slots.register(
          { id: 'novel-editor', order: 50, label: () => (ctx.locale ? ctx.locale.get('novel-editor.title') : '创作工作台') },
          () => h(StudioView, { ctx }),
        ));
        // 右侧栏 markdown 预览（小说排版）
        ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
          { key: 'markdown-novel' },
          (node) => h(NovelDocPreview, { node }),
        ));
      },
    };
  },
});
