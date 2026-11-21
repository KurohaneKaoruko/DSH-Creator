import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

export const REQUIRED_CLIENT_DEPENDENCIES = Object.freeze([
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-sidebar',
]);

const REQUIRED_EXPORTS = Object.freeze({
  '.': './plugins/workbench/index.js',
  './client': './plugins/workbench/client.js',
});

const REQUIRED_FILES = Object.freeze([
  'cordis.patch.yml',
  'plugins/creator-tools.mjs',
  'plugins/project-core.mjs',
  'plugins/lint.mjs',
  'plugins/workbench/index.js',
  'plugins/workbench/client.js',
  'plugins/workbench/locale/en.json',
  'plugins/workbench/locale/zh.json',
  'plugins/workbench/icons/icon.svg',
  'skills/README.md',
  'skills/LICENSE',
]);

/** 返回包清单及安装目录中的不兼容项，空数组表示通过。 */
export function inspectBundleContract(pkg, bundleDir, options = {}) {
  const exists = options.exists || existsSync;
  const listDir = options.listDir || ((target) => readdirSync(target, { withFileTypes: true }));
  const errors = [];
  const client = pkg && pkg.dsh && pkg.dsh.client;

  if (!client || client.platform !== 'web') errors.push('package.json 缺少 dsh.client.platform=web');
  if (!client || client.immediately !== true) errors.push('dsh.client.immediately 必须为 true');
  const declared = new Set((client && Array.isArray(client.inject) ? client.inject : []));
  for (const dependency of REQUIRED_CLIENT_DEPENDENCIES) {
    if (!declared.has(dependency)) errors.push(`dsh.client.inject 缺少依赖 ${dependency}`);
  }

  for (const [specifier, target] of Object.entries(REQUIRED_EXPORTS)) {
    if (!pkg || !pkg.exports || pkg.exports[specifier] !== target) {
      errors.push(`package.json exports[${JSON.stringify(specifier)}] 应指向 ${target}`);
    }
  }

  for (const file of REQUIRED_FILES) {
    if (!exists(path.join(bundleDir, file))) errors.push(`安装落位缺少文件：${file}`);
  }

  const skillsDir = path.join(bundleDir, 'skills');
  if (exists(skillsDir)) {
    try {
      const skillDirs = listDir(skillsDir).filter((entry) => entry.isDirectory());
      for (const entry of skillDirs) {
        const skillFile = path.join('skills', entry.name, 'SKILL.md');
        if (!exists(path.join(bundleDir, skillFile))) errors.push(`安装落位缺少 skill 文件：${skillFile}`);
      }
    } catch (err) {
      errors.push(`无法检查 skills 目录：${String((err && err.message) || err)}`);
    }
  }

  return errors;
}
