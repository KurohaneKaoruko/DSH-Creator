// Host half of dsh-novel-editor.
//
// Registers one webServer prefix route `/novel-editor/api` that the Client
// editor uses to save chapter files back into the current workspace. Reads go
// through the official Remote channel (ctx.remote.workspaceFiles) on the Client
// side; writes need a Host-side route because the Remote surface is read-only.
//
// Security model (mirrors dsh-better-sidebar):
//   - writes are constrained to *.md files inside a known workspace directory;
//   - every write requires the exact path + full content (no partial ops);
//   - payload cap 8 MiB to bound abuse.

export const inject = ['webServer', 'fs'];

/** @param {any} ctx cordis context */
export function apply(ctx) {
  const writeJson = (res, status, payload) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
  };

  const readBody = (req, limit = 8 * 1024 * 1024) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  const disposers = [
    ctx.webServer.register({
      kind: 'prefix',
      path: '/novel-editor/v1/api',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST' || !req.url.startsWith('/save')) {
            return writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'not found' } });
          }
          const body = JSON.parse(await readBody(req));
          const { path, content } = body || {};
          if (typeof path !== 'string' || typeof content !== 'string') {
            return writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'path and content are required' } });
          }
          if (!/\.md$/i.test(path)) {
            return writeJson(res, 400, { ok: false, error: { code: 'bad-file', message: 'only .md files are writable' } });
          }
          // 写入走沙箱组合文件系统（与 Agent 的 write 工具同一通道，保留工作区边界）
          const outcome = await ctx.fs.writeText(path, content);
          if (outcome && outcome.outcome === 'denied') {
            return writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'write denied by sandbox' } });
          }
          return writeJson(res, 200, { ok: true });
        } catch (err) {
          return writeJson(res, 500, { ok: false, error: { code: 'error', message: String((err && err.message) || err) } });
        }
      },
    }),
  ];

  return () => disposers.forEach((d) => d && d());
}
