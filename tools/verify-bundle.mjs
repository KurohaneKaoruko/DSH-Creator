#!/usr/bin/env node
// tools/verify-bundle.mjs — 创作工作台 bundle 冒烟测试（DSH ≥ 0.1.7-alpha.1，含 0.2.x）。
//
// 项目主体是工作台插件，四个创作助手是同一 bundle 里的预设。目录式预设
// （$DSH_HOME/.agent-presets/）自 0.1.7-alpha.1 起不再被读取，安装方式是 bundle：
// package.json 的 dsh.bundle.patch 指向 cordis.patch.yml。
//
// 本脚本模拟插件管理器 install_bundle 的最终落位：把 bundle 以 file: 依赖装进
// profile（node_modules/dsh-creator/），profile 声明 bundles 含 dsh-creator，
// 然后用真实内核按 ACP 启动，并由组合内探针（creator-probe）盘问 registry：
//   1. ROSTER 含四个助手且均无 broken；
//   2. 四个预设的 diagnostic 均为空（行级 schema 与 import 全部通过）；
//   3. presets.mount() 能把预设挂进 scope（bind 真实发生）；
//   4. 挂载后的 scoped skills 能发现随包分发的 18 个 novel-* skill；
//   5. 安装落位含工作台 Host/Client 与共享工程内核文件，package.json 带
//      dsh.client（platform: web）声明。
// 注意：ACP 不接预设（web/desktop 的 api-session-controller 才是挂载方），因此
// 「session/new 成功」不构成证据，一切以探针读到的 registry 状态为准。
//
// 用法：node verify-bundle.mjs [--home .testhome-bundle] [--kernel kernel-verify]
//        [--profile novel-bundle] [--bundle-dir <dir>] [--node <node.exe>]

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const toolsDir = path.resolve(url.fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = path.resolve(toolsDir, "..");
const args = process.argv.slice(2);
const get = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
};
const home = path.resolve(toolsDir, get("--home", ".testhome-bundle"));
const kernelDirName = get("--kernel", "kernel-bundle");
const kernelDir = path.isAbsolute(kernelDirName) ? kernelDirName : path.join(toolsDir, kernelDirName);
const profile = get("--profile", "novel-bundle");
const nodeBin = get("--node", process.execPath);
// 被安装的 bundle 来源；默认仓库根目录。证伪实验可指向一个故意改坏的副本。
const bundleDir = path.resolve(toolsDir, get("--bundle-dir", repoRoot));
const kernelBin = path.join(kernelDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

if (!fs.existsSync(kernelBin)) {
  console.error("[verify-bundle] 内核未安装：node kernel-install.mjs --version <ver> --at " + kernelDirName);
  process.exit(1);
}
const kernelPkg = JSON.parse(fs.readFileSync(path.join(kernelDir, "node_modules", "@deepseek-ai", "dsh", "package.json"), "utf8"));

function fail(msg) {
  console.error("[verify-bundle] 失败：" + msg);
  process.exit(1);
}

// ---- provision：profile（含 file: 安装本 bundle + 探针行） -------------------

const profileDir = path.join(home, "profiles", profile);
fs.mkdirSync(profileDir, { recursive: true });

const profilePkg = {
  name: "dsh-profile-novel-bundle",
  private: true,
  dependencies: {
    // file: 安装 bundle 来源目录 —— 等价于插件管理器把本 bundle 装进 profile 的落位。
    "dsh-creator": "file:" + bundleDir.split(path.sep).join("/"),
  },
  dsh: {
    profile: {
      bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app", "dsh-creator"],
      patchReload: "startup",
    },
  },
};
fs.writeFileSync(path.join(profileDir, "package.json"), JSON.stringify(profilePkg, null, 2) + "\n", "utf8");

// 探针插件：组合内运行，inject agentPresets，把 registry 实况写到 stderr。
// （相对路径行锚定在 profile patch 文件旁 —— 即本目录。）
const EXPECTED_ASSISTANTS = ["novelist", "screenwriter", "gamescript", "general-creator"];
const probePlugin = `
export const name = "creator-probe";
export const inject = ["agentPresets"];
const EXPECTED = ${JSON.stringify(EXPECTED_ASSISTANTS)};
export async function apply(ctx) {
  const presets = ctx.agentPresets;
  const out = (line) => process.stderr.write("[creator-probe] " + line + "\\n");
  try {
    let list = [];
    for (let i = 0; i < 40; i++) {
      list = await presets.list();
      if (EXPECTED.every((id) => list.some((r) => r.id === id))) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    out("ROSTER " + JSON.stringify(list));
    let healthy = true;
    for (const id of EXPECTED) {
      const record = [...presets.definitions.values()].find((r) => r.config && r.config.id === id);
      if (!record) { out("DIAG " + id + " FAIL no-record"); healthy = false; continue; }
      const problem = await presets.diagnostic(record);
      out("DIAG " + id + " " + (problem === undefined ? "(healthy)" : problem));
      if (problem !== undefined) healthy = false;
    }
    if (!healthy) { out("VERDICT BROKEN"); return; }
    // 挂载后的 scoped skills 读取（官方路径：acquireScope + skills.list({cwd, scope})，
    // 与 api-session-controller 完全一致）。
    const lease = await presets.acquireScope("novelist");
    try {
      const skills = ctx.get("skills");
      if (skills === undefined) {
        out("SKILLS absent");
      } else {
        const listed = await skills.list({ cwd: process.env.DSH_PROBE_CWD, scope: lease.key });
        out("SKILLS " + JSON.stringify((listed ?? []).map((s) => s.name).sort()));
      }
    } finally {
      await lease[Symbol.asyncDispose]();
    }
    out("VERDICT OK");
  } catch (e) {
    out("VERDICT FAIL " + String((e && e.stack) || e).slice(0, 900));
  }
}
`;
fs.writeFileSync(path.join(profileDir, "creator-probe.mjs"), probePlugin, "utf8");

const ws = path.join(home, "workspace-demo");
fs.mkdirSync(ws, { recursive: true });

const profilePatch = [
  "# creator workbench 验证 profile（由 tools/verify-bundle.mjs 生成，请勿手改）。",
  "# 组合：dsh-base + dsh-acp-app（宿主层）+ agent-preset-registry（服务 agentPresets）",
  "# + dsh-creator bundle 的声明层 + 探针行（最后一个 insert，等 registry 激活后运行）。",
  "",
  "# 部署级兜底人设：预设挂载失败时仍是写作 Agent 语义（正常路径由预设 persona 接管）。",
  "- id: system-prompt",
  "  config:",
  "    persona: >-",
  "      你是一个面向小说作者的写作智能体，由 {{model}} 驱动。",
  "",
  "# 预设名单提供方（bundle 的声明行 inject 本服务）。default 指向 novelist。",
  "- insert:",
  "    - id: agent-preset-registry",
  "      name: '@deepseek-ai/dsh-agent-preset-registry'",
  "      config:",
  "        default: novelist",
  "",
  "# 探针行：inject agentPresets，激活即盘问并落 stderr（断言由 verify-bundle 做）。",
  "- insert:",
  "    - id: creator-probe",
  "      name: './creator-probe.mjs'",
  "",
].join("\n");
fs.writeFileSync(path.join(profileDir, "cordis.patch.yml"), profilePatch, "utf8");

console.log("[verify-bundle] 内核: @deepseek-ai/dsh@" + kernelPkg.version);
console.log("[verify-bundle] home: " + home);
console.log("[verify-bundle] 在 profile 内安装 bundle（file: 依赖）…");
{
  // Windows 上 Node 禁止无 shell 直接 spawn .cmd —— 经 cmd.exe 调 npm。
  const npmArgs = ["install", "--no-audit", "--no-fund", "--loglevel", "error", "--cache", path.join(toolsDir, ".npm-cache")];
  const res = process.platform === "win32"
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", "npm"].concat(npmArgs), { cwd: profileDir, stdio: "pipe" })
    : spawnSync("npm", npmArgs, { cwd: profileDir, stdio: "pipe" });
  if (res.status !== 0) fail("profile 内 npm install 失败（exit " + res.status + "）\n" + String(res.stderr ?? ""));
}
const installedDir = path.join(profileDir, "node_modules", "dsh-creator");
const installed = JSON.parse(fs.readFileSync(path.join(installedDir, "package.json"), "utf8"));
console.log("[verify-bundle] bundle 已装: dsh-creator@" + installed.version);
const requiredFiles = [
  "cordis.patch.yml",
  "plugins/creator-tools.mjs",
  "plugins/project-core.mjs",
  "plugins/workbench/index.js",
  "plugins/workbench/client.js",
  "plugins/workbench/locale/zh.json",
  "skills/novel-craft/SKILL.md",
];
for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(installedDir, file))) fail("安装落位缺少文件：" + file);
}
if (!installed.dsh || !installed.dsh.client || installed.dsh.client.platform !== "web") {
  fail("package.json 缺少 dsh.client（platform: web）声明");
}
console.log("[verify-bundle] 落位文件与 dsh.client 声明完整（工作台 Host/Client + 工程内核 + skills）");

// ---- 启动内核，收集探针输出 ---------------------------------------------------

const child = spawn(nodeBin, [kernelBin, "--profile", profile], {
  cwd: home,
  env: {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: "1",
    DSH_PROBE_ANCHOR: path.join(kernelDir, "package.json"),
    DSH_PROBE_CWD: ws,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

const probeLines = [];
const errChunks = [];
let finished = false;
child.stderr.on("data", (c) => {
  const text = c.toString("utf8");
  errChunks.push(text);
  for (const line of text.split("\n")) {
    if (line.startsWith("[creator-probe]")) probeLines.push(line.slice("[creator-probe] ".length));
  }
});
const errTail = () => Buffer.concat(errChunks.map((s) => Buffer.from(s))).toString("utf8").slice(-5000);
child.on("exit", (code) => {
  if (!finished) fail("内核提前退出（code=" + code + "）\nstderr:\n" + errTail());
});
child.stdout.on("data", () => {});
process.on("exit", () => { try { child.kill(); } catch {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const verdictLine = () => probeLines.find((l) => l.startsWith("VERDICT"));

// 等探针给出结论（registry 激活 + mount + skills 盘点需要一些时间）。
let waited = 0;
while (verdictLine() === undefined && waited < 120000) {
  await sleep(500);
  waited += 500;
}

finished = true;
try { child.kill(); } catch {}

const verdict = verdictLine();
console.log("");
console.log("── 探针输出 ──");
for (const line of probeLines) console.log("  " + line.slice(0, 2000));
console.log("");

if (verdict === undefined) fail("探针 120s 内未给出 VERDICT。\nstderr:\n" + errTail());
if (!verdict.startsWith("VERDICT OK")) fail("探针判定失败：" + verdict + "\nstderr:\n" + errTail());

const rosterLine = probeLines.find((l) => l.startsWith("ROSTER "));
const roster = rosterLine ? JSON.parse(rosterLine.slice("ROSTER ".length)) : [];
for (const id of EXPECTED_ASSISTANTS) {
  const entry = roster.find((r) => r.id === id);
  if (!entry) fail("roster 缺少助手：" + id);
  if (entry.broken !== undefined) fail(id + " 带 broken 诊断：" + entry.broken);
}
for (const name of ["小说助手", "编剧助手", "游戏剧本助手", "通用创作助手"]) {
  if (!roster.some((r) => r.name === name)) fail("roster 缺少显示名：" + name);
}
const skillsLine = probeLines.find((l) => l.startsWith("SKILLS "));
const skillNames = skillsLine ? JSON.parse(skillsLine.slice("SKILLS ".length)) : [];
const expectedSkills = [
  "novel-ai-lexicon", "novel-ai-structure", "novel-analysis", "novel-chapter-plan", "novel-continuity",
  "novel-craft", "novel-human-touch", "novel-plotting", "novel-profiles", "novel-project",
  "novel-prose-standards", "novel-revision",
  "novel-style-hotblood", "novel-style-lightnovel", "novel-style-mystery",
  "novel-style-romance", "novel-style-scifi", "novel-style-xianxia",
];
const missing = expectedSkills.filter((s) => !skillNames.includes(s));
if (missing.length > 0) fail("挂载后的 skills 缺少：" + missing.join(", ") + "（实际 " + skillNames.length + " 个）");

console.log("PASS — bundle 路线全链路挂载（dsh@" + kernelPkg.version + "）");
console.log("  roster: 四个助手（小说/编剧/游戏剧本/通用）在册且无 broken；四个 diagnostic=(healthy)；acquireScope=ok");
console.log("  skills: " + skillNames.length + " 个 novel-* 全部经随包目录发现");
process.exit(0);
