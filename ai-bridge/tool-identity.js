'use strict';

/**
 * AI Bridge 工具身份规范化（纯函数，无 I/O）。
 *
 * 对外继续保留历史调度名 name；内部使用带 transport 的稳定实例 ID，
 * 防止 CLI、MCP 客户端、开关键和统计键落入同一个字符串空间。
 */

const KNOWN_ALIAS_GROUPS = {
  'atom-code': ['atom-code', 'atomcode'],
  openclaw: ['openclaw', 'client-openclaw']
};

function normalizeToolName (value) {
  return String(value || '').trim().toLowerCase();
}

function canonicalToolId (value, type = 'cli') {
  let name = normalizeToolName(value);
  name = name.replace(/^(cli|client):/, '');

  // client-openclaw 是为解决 CLI 同名冲突生成的历史调度名，不是独立产品。
  if (type === 'client' && name === 'client-openclaw') name = 'openclaw';

  for (const [canonical, aliases] of Object.entries(KNOWN_ALIAS_GROUPS)) {
    if (aliases.includes(name)) return canonical;
  }
  return name;
}

function aliasesFor (canonicalId) {
  const canonical = normalizeToolName(canonicalId);
  return [...(KNOWN_ALIAS_GROUPS[canonical] || [canonical])];
}

function buildToolIdentity (tool) {
  const type = tool?.type === 'client' ? 'client' : 'cli';
  const name = normalizeToolName(tool?.name);
  const sourceId = normalizeToolName(tool?.sourceId || tool?.clientKey || tool?.name);
  const canonicalId = canonicalToolId(sourceId || name, type);
  const id = `${type}:${canonicalId}`;
  const aliases = [...new Set([
    id,
    name,
    sourceId,
    ...(type === 'client' ? [`client-${canonicalId}`] : []),
    ...aliasesFor(canonicalId)
  ].filter(Boolean))];

  return { id, canonicalId, sourceId, aliases, type };
}

function decorateToolIdentity (tool) {
  return { ...tool, ...buildToolIdentity(tool) };
}

/**
 * 解析调用方传入的历史名称、稳定实例 ID 或别名。
 * 优先精确匹配 name/id/sourceId；模糊别名若命中多个 transport 则拒绝猜测。
 */
function resolveToolReference (reference, tools) {
  const wanted = normalizeToolName(reference);
  if (!wanted) return null;
  const decorated = (tools || []).map(t => t.id ? t : decorateToolIdentity(t));

  // 调度名和稳定实例 ID 是唯一的，优先处理。
  const exact = decorated.find(t =>
    normalizeToolName(t.name) === wanted ||
    normalizeToolName(t.id) === wanted
  );
  if (exact) return exact;

  // sourceId 可能同时被 CLI 和客户端占用，歧义时不能按数组顺序猜测。
  const sourceMatches = decorated.filter(t => normalizeToolName(t.sourceId) === wanted);
  if (sourceMatches.length === 1) return sourceMatches[0];
  if (sourceMatches.length > 1) return null;

  const matches = decorated.filter(t => (t.aliases || []).map(normalizeToolName).includes(wanted));
  return matches.length === 1 ? matches[0] : null;
}

function switchKeysFor (tool) {
  const t = tool.id ? tool : decorateToolIdentity(tool);
  // 新稳定键优先，历史调度名兜底。不能盲用 sourceId：client-openclaw 的
  // sourceId=openclaw，会与 cli:openclaw 的旧开关键发生串扰。
  return [...new Set([t.id, t.name].map(normalizeToolName).filter(Boolean))];
}

function statsKeysFor (tool, allTools = []) {
  const t = tool.id ? tool : decorateToolIdentity(tool);
  const candidates = [...new Set([t.id, t.name].map(normalizeToolName).filter(Boolean))];
  if (!allTools.length) return candidates;

  // 只有能明确解析回当前实例的历史键才聚合，避免把 cli:openclaw 的历史量算到 client:openclaw。
  return candidates.filter(key => {
    const resolved = resolveToolReference(key, allTools);
    return resolved && resolved.id === t.id;
  });
}

module.exports = {
  KNOWN_ALIAS_GROUPS,
  normalizeToolName,
  canonicalToolId,
  aliasesFor,
  buildToolIdentity,
  decorateToolIdentity,
  resolveToolReference,
  switchKeysFor,
  statsKeysFor
};
