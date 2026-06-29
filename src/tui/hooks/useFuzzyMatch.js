'use strict';

const React = require('react');
const { fuzzyMatch, prepareCandidates } = require('../utils/fuzzyMatch');

/**
 * 模糊匹配 Hook
 *
 * 使用方式:
 * const { matches, addCandidates, clearCandidates } = useFuzzyMatch(['help', 'scan', 'status']);
 */
const useFuzzyMatch = (initialCandidates = []) => {
  const [candidates, setCandidates] = React.useState(initialCandidates);
  const [prepared, setPrepared] = React.useState(null);

  // 准备候选列表
  React.useEffect(() => {
    if (candidates.length > 0) {
      setPrepared(prepareCandidates(candidates));
    } else {
      setPrepared(null);
    }
  }, [candidates]);

  // 添加候选
  const addCandidates = React.useCallback((newCandidates) => {
    setCandidates(prev => {
      const updated = [...new Set([...prev, ...newCandidates])];
      return updated;
    });
  }, []);

  // 清空候选
  const clearCandidates = React.useCallback(() => {
    setCandidates([]);
    setPrepared(null);
  }, []);

  // 模糊匹配
  const match = React.useCallback((input, limit = 10) => {
    if (!input) return candidates.slice(0, limit);
    if (prepared) {
      return fuzzyMatch(input, candidates, limit);
    }
    return fuzzyMatch(input, candidates, limit);
  }, [candidates, prepared]);

  return {
    candidates,
    addCandidates,
    clearCandidates,
    match
  };
};

module.exports = { useFuzzyMatch };
