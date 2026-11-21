#!/usr/bin/env node
import { MIN_SUPPORTED_DSH, checkCompatibility, compareVersions, parseVersion } from './compatibility.mjs';

const args = process.argv.slice(2);
const get = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};

const dshVersion = get('--dsh-version');
if (!dshVersion) {
  console.error('用法：node check-compat.mjs --dsh-version <版本> [--installed-bundles <逗号分隔的 bundle 名称>]');
  process.exit(2);
}

const bundles = (get('--installed-bundles') || '').split(',').map((name) => name.trim()).filter(Boolean);
const result = checkCompatibility(dshVersion, bundles);
for (const warning of result.warnings) console.warn(`[compat] ${warning}`);
for (const error of result.errors) console.error(`[compat] ${error}`);
if (result.errors.length) process.exit(1);
console.log(`[compat] DSH ${parseVersion(dshVersion).raw} 满足最低版本 ${MIN_SUPPORTED_DSH}`);
console.log('[compat] 检查通过');
