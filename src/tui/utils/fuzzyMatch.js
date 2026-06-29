'use strict';

/**
 * 模糊匹配算法
 *
 * 示例:
 *   fuzzyMatch('wri', ['write', 'workspace', 'wrap', 'run'])
 *   // => ['write', 'workspace', 'wrap']
 *
 *   fuzzyMatch('ctx', ['context', 'cat', 'cut', 'copy'])
 *   // => ['context', 'cat', 'cut']
 */

let fuzzysort;
try {
  fuzzysort = require('fuzzysort');
} catch (e) {
  fuzzysort = null;
}

/**
 * 模糊匹配
 * @param {string} input - 用户输入
 * @param {string[]} candidates - 候选列表
 * @param {number} limit - 返回结果数量限制
 * @returns {string[]} 匹配结果（按得分排序）
 */
function fuzzyMatch(input, candidates, limit = 10) {
  if (!input || !candidates || candidates.length === 0) {
    return candidates || [];
  }

  // 如果 fuzzysort 不可用，使用简单匹配
  if (!fuzzysort) {
    return simpleFuzzyMatch(input, candidates, limit);
  }

  // 使用 fuzzysort 进行模糊匹配
  const results = fuzzysort.go(input, candidates, { limit });

  return results.map(r => r.target);
}

/**
 * 准备候选列表（用于预计算）
 * @param {string[]} candidates - 候选列表
 * @returns {Object} 准备好的候选列表
 */
function prepareCandidates(candidates) {
  if (!candidates || candidates.length === 0) {
    return null;
  }

  if (!fuzzysort) {
    return candidates;
  }

  return fuzzysort.prepare(candidates);
}

/**
 * 模糊匹配（使用预计算的候选列表）
 * @param {string} input - 用户输入
 * @param {Object} prepared - 预计算的候选列表
 * @param {number} limit - 返回结果数量限制
 * @returns {string[]} 匹配结果
 */
function fuzzyMatchPrepared(input, prepared, limit = 10) {
  if (!input || !prepared) {
    return [];
  }

  if (!fuzzysort) {
    return simpleFuzzyMatch(input, prepared, limit);
  }

  const results = fuzzysort.go(input, prepared, { limit });
  return results.map(r => r.target);
}

/**
 * 简单的内置模糊匹配（不依赖 fuzzysort）
 * 仅用于 fallback
 */
function simpleFuzzyMatch(input, candidates, limit = 10) {
  if (!input || !candidates || candidates.length === 0) {
    return candidates || [];
  }

  const normalizedInput = input.toLowerCase().trim();
  if (normalizedInput.length === 0) {
    return candidates.slice(0, limit);
  }

  const scored = candidates.map(c => ({
    item: c,
    score: calculateScore(normalizedInput, c.toLowerCase())
  }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(r => r.item);
}

/**
 * 计算模糊匹配得分
 */
function calculateScore(input, target) {
  let inputIndex = 0;
  let targetIndex = 0;
  let score = 0;
  let consecutiveBonus = 0;
  let lastMatchIndex = -1;
  let wordBoundaryBonus = 0;

  while (inputIndex < input.length && targetIndex < target.length) {
    if (input[inputIndex] === target[targetIndex]) {
      score += 1;

      // 连续匹配加分
      if (lastMatchIndex === targetIndex - 1) {
        consecutiveBonus += 5;
        score += consecutiveBonus;
      } else {
        consecutiveBonus = 0;
      }

      // 首字符匹配额外加分
      if (targetIndex === 0) {
        score += 10;
      }

      // 单词边界匹配加分
      if (targetIndex > 0 && isWordBoundary(target[targetIndex - 1])) {
        wordBoundaryBonus += 5;
        score += wordBoundaryBonus;
      }

      lastMatchIndex = targetIndex;
      inputIndex++;
    }
    targetIndex++;
  }

  return inputIndex === input.length ? score : 0;
}

/**
 * 判断是否为单词边界
 */
function isWordBoundary(char) {
  return /[\s\-_.:]/.test(char);
}

module.exports = {
  fuzzyMatch,
  fuzzyMatchPrepared,
  prepareCandidates,
  simpleFuzzyMatch
};
