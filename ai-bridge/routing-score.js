'use strict';

/**
 * AI Bridge 可解释综合路由评分（纯函数，无 I/O）。
 *
 * 只使用系统真实拥有的信号：任务结果、耗时、Token、fallback 与时间戳。
 * “成本”代表平均 Token 消耗，不伪装成人民币或 API 价格。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WEIGHTS = Object.freeze({
  success: 0.30,
  capability: 0.20,
  latency: 0.15,
  tokenCost: 0.10,
  freshness: 0.10,
  stability: 0.10,
  confidence: 0.05
});

function clamp01 (value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function parseDurationMs (value) {
  if (Number.isFinite(value)) return Math.max(0, value);
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  const match = text.match(/^([0-9]+(?:\.[0-9]+)?)\s*(ms|s|sec|secs|second|seconds)?$/);
  if (!match) return null;
  const n = Number(match[1]);
  return match[2] === 'ms' ? n : n * 1000;
}

function classifyTask (task) {
  const text = String(task || '').toLowerCase();
  if (/(review|审查|评审|检查代码|code review|安全审计|audit)/i.test(text)) return 'review';
  if (/(写|实现|修复|重构|函数|代码|python|javascript|typescript|node|java|go\b|rust|sql|bug|test|测试用例|接口|api|脚本)/i.test(text)) return 'code';
  if (/(分析|比较|调研|研究|原因|诊断|评估|方案|架构|设计)/i.test(text)) return 'analysis';
  if (/(文档|报告|说明|总结|readme|release note|教程)/i.test(text)) return 'docs';
  if (/(部署|启动|停止|进程|服务|日志|运维|环境|配置|docker|server)/i.test(text)) return 'ops';
  return 'general';
}

function decayWeight (ts, now, halfLifeDays = 14) {
  const time = Date.parse(ts || '');
  if (!Number.isFinite(time)) return 0.5;
  const age = Math.max(0, now - time);
  return Math.pow(0.5, age / (Math.max(1, halfLifeDays) * DAY_MS));
}

function bayesianRate (successes, calls, priorMean = 0.5, priorStrength = 4) {
  return (successes + priorMean * priorStrength) / (calls + priorStrength);
}

function wilsonLowerBound (successes, calls, z = 1.28) {
  if (calls <= 0) return 0.5;
  const p = successes / calls;
  const z2 = z * z;
  const denom = 1 + z2 / calls;
  const centre = p + z2 / (2 * calls);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * calls)) / calls);
  return clamp01((centre - margin) / denom);
}

function average (values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, v) => sum + v, 0) / valid.length : null;
}

function buildRoutingProfile (tool, observations, tokenSummary = {}, now = Date.now()) {
  const rows = (observations || []).filter(Boolean);
  let weightedCalls = 0;
  let weightedSuccesses = 0;
  const categoryStats = {};
  let lastObservedAt = null;
  let lastSuccessAt = null;
  let lastFailureAt = null;

  for (const row of rows) {
    const weight = decayWeight(row.ts, now);
    weightedCalls += weight;
    if (row.success) weightedSuccesses += weight;
    const category = row.category || classifyTask(row.task);
    if (!categoryStats[category]) categoryStats[category] = { calls: 0, successes: 0 };
    categoryStats[category].calls += weight;
    if (row.success) categoryStats[category].successes += weight;
    if (row.ts && (!lastObservedAt || row.ts > lastObservedAt)) lastObservedAt = row.ts;
    if (row.success && row.ts && (!lastSuccessAt || row.ts > lastSuccessAt)) lastSuccessAt = row.ts;
    if (!row.success && row.ts && (!lastFailureAt || row.ts > lastFailureAt)) lastFailureAt = row.ts;
  }

  const exactCalls = rows.length;
  const exactSuccesses = rows.filter(r => r.success).length;
  const durations = rows.map(r => parseDurationMs(r.durationMs ?? r.duration)).filter(Number.isFinite);
  const observedTokens = rows.map(r => Number(r.tokens)).filter(v => Number.isFinite(v) && v > 0);
  const aggregateCalls = Number(tokenSummary.calls) || 0;
  const aggregateTokens = Number(tokenSummary.total) || 0;
  const averageTokens = observedTokens.length
    ? average(observedTokens)
    : aggregateCalls > 0 ? aggregateTokens / aggregateCalls : null;
  const averageDurationMs = durations.length
    ? average(durations)
    : parseDurationMs(tokenSummary.lastDuration);
  const successScore = bayesianRate(weightedSuccesses, weightedCalls);
  const confidence = clamp01(1 - Math.exp(-weightedCalls / 8));
  const freshness = lastObservedAt
    ? clamp01(Math.exp(-Math.max(0, now - Date.parse(lastObservedAt)) / (21 * DAY_MS)))
    : 0.35;
  const lastSuccessMs = Date.parse(lastSuccessAt || '');
  const lastFailureMs = Date.parse(lastFailureAt || '');
  // 最近一次结果为失败时进入短期冷却。冷却不是永久封禁：30 分钟后自动恢复参与排名。
  const cooldownUntilMs = Number.isFinite(lastFailureMs) &&
    (!Number.isFinite(lastSuccessMs) || lastFailureMs > lastSuccessMs)
    ? lastFailureMs + 30 * 60 * 1000
    : null;
  const coolingDown = Number.isFinite(cooldownUntilMs) && cooldownUntilMs > now;

  return {
    tool: tool.name,
    toolId: tool.id,
    canonicalId: tool.canonicalId,
    calls: exactCalls,
    successes: exactSuccesses,
    weightedCalls,
    weightedSuccesses,
    successScore,
    stabilityScore: wilsonLowerBound(weightedSuccesses, weightedCalls),
    confidence,
    freshness,
    averageDurationMs,
    averageTokens,
    lastObservedAt,
    lastSuccessAt,
    lastFailureAt,
    cooldownUntil: coolingDown ? new Date(cooldownUntilMs).toISOString() : null,
    coolingDown,
    categoryStats
  };
}

function capabilityScore (profile, category) {
  const stats = profile.categoryStats?.[category];
  if (!stats || stats.calls <= 0) return profile.successScore;
  const categoryRate = bayesianRate(stats.successes, stats.calls, profile.successScore, 3);
  const categoryConfidence = clamp01(1 - Math.exp(-stats.calls / 4));
  return categoryRate * categoryConfidence + profile.successScore * (1 - categoryConfidence);
}

function latencyScore (averageDurationMs) {
  if (!Number.isFinite(averageDurationMs)) return 0.45;
  return clamp01(1 / (1 + averageDurationMs / 30000));
}

function tokenCostScore (averageTokens) {
  if (!Number.isFinite(averageTokens)) return 0.45;
  return clamp01(1 / (1 + averageTokens / 4000));
}

function scoreRoutingProfile (profile, category, weights = DEFAULT_WEIGHTS) {
  const components = {
    success: clamp01(profile.successScore),
    capability: clamp01(capabilityScore(profile, category)),
    latency: latencyScore(profile.averageDurationMs),
    tokenCost: tokenCostScore(profile.averageTokens),
    freshness: clamp01(profile.freshness),
    stability: clamp01(profile.stabilityScore),
    confidence: clamp01(profile.confidence)
  };
  let weightedScore = 0;
  for (const [key, weight] of Object.entries(weights)) weightedScore += components[key] * weight;

  // 冷启动只给小幅探索机会，不允许零样本工具压过已证明可靠的工具。
  const explorationBonus = 0.04 / Math.sqrt(profile.calls + 1);
  // 冷却中的工具保留完整分量供解释，但排名分数归零，避免刚失败后立即重试同一链路。
  const score = profile.coolingDown ? 0 : clamp01(weightedScore + explorationBonus);
  return {
    ...profile,
    category,
    score: +score.toFixed(4),
    components: Object.fromEntries(Object.entries(components).map(([k, v]) => [k, +v.toFixed(4)])),
    explorationBonus: +explorationBonus.toFixed(4),
    reason: profile.coolingDown
      ? `冷却至${profile.cooldownUntil} · 最近失败${profile.lastFailureAt}`
      : `成功${components.success.toFixed(2)} · 能力${components.capability.toFixed(2)} · 时延${components.latency.toFixed(2)} · Token成本${components.tokenCost.toFixed(2)} · 新鲜度${components.freshness.toFixed(2)} · 稳定性${components.stability.toFixed(2)} · 置信度${components.confidence.toFixed(2)}`
  };
}

function rankRoutingProfiles (profiles, task, weights = DEFAULT_WEIGHTS) {
  const category = classifyTask(task);
  return (profiles || [])
    .map(profile => scoreRoutingProfile(profile, category, weights))
    .sort((a, b) => b.score - a.score || b.confidence - a.confidence || a.tool.localeCompare(b.tool));
}

module.exports = {
  DAY_MS,
  DEFAULT_WEIGHTS,
  clamp01,
  parseDurationMs,
  classifyTask,
  decayWeight,
  bayesianRate,
  wilsonLowerBound,
  buildRoutingProfile,
  capabilityScore,
  latencyScore,
  tokenCostScore,
  scoreRoutingProfile,
  rankRoutingProfiles
};
