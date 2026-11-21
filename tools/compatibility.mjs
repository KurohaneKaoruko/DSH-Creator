export const MIN_SUPPORTED_DSH = '0.2.2-rc.2';
export const LEGACY_WORKBENCH_BUNDLE = 'dsh-novel-editor';
export const CREATOR_BUNDLE = 'dsh-creator';

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(input) {
  const text = String(input || '').trim();
  const match = text.match(VERSION_RE);
  if (!match) throw new Error(`无效的语义版本号：${text || '(空)'}`);
  const prerelease = match[4] ? match[4].split('.') : [];
  if (prerelease.some((part) => !part || (/^\d+$/.test(part) && part.length > 1 && part.startsWith('0')))) {
    throw new Error(`无效的预发布版本号：${text}`);
  }
  return {
    raw: text.replace(/^v/, '').split('+')[0],
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length ? -1 : 1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    if (a.prerelease[i] === undefined) return -1;
    if (b.prerelease[i] === undefined) return 1;
    const an = /^\d+$/.test(a.prerelease[i]);
    const bn = /^\d+$/.test(b.prerelease[i]);
    if (an && bn) {
      const ai = Number(a.prerelease[i]), bi = Number(b.prerelease[i]);
      if (ai !== bi) return ai < bi ? -1 : 1;
    } else if (an !== bn) {
      return an ? -1 : 1;
    } else if (a.prerelease[i] !== b.prerelease[i]) {
      return a.prerelease[i] < b.prerelease[i] ? -1 : 1;
    }
  }
  return 0;
}

export function checkCompatibility(dshVersion, installedBundles = []) {
  const errors = [];
  const warnings = [];
  let parsed;
  try {
    parsed = parseVersion(dshVersion);
  } catch (err) {
    return { errors: [String((err && err.message) || err)], warnings };
  }

  if (compareVersions(parsed.raw, MIN_SUPPORTED_DSH) < 0) {
    errors.push(`DSH ${parsed.raw} 过低；创作工作台侧栏面板要求 DSH >= ${MIN_SUPPORTED_DSH}。请先升级 DSH。`);
  }

  const bundles = installedBundles.map((name) => String(name).trim()).filter(Boolean);
  const creatorCount = bundles.filter((name) => name === CREATOR_BUNDLE).length;
  if (creatorCount > 1) errors.push(`检测到 ${creatorCount} 个 ${CREATOR_BUNDLE} 安装项；请移除重复项后再启动。`);
  if (bundles.includes(LEGACY_WORKBENCH_BUNDLE)) {
    warnings.push(`检测到旧编辑器 ${LEGACY_WORKBENCH_BUNDLE}；请卸载旧 bundle，避免出现重复工作台入口。`);
  }
  return { errors, warnings };
}
