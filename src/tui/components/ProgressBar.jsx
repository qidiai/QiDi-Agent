'use strict';

const React = require('react');
const { Box, Text } = require('ink');

const ProgressBar = ({
  current = 0,
  total = 0,
  startTime = null,
  label = 'Progress',
  width = 20
}) => {
  const percentage = total > 0 ? Math.round((current / total) * 100) : 0;

  // 计算 ETA
  const eta = React.useMemo(() => {
    if (current === 0 || !startTime) return '--';
    const elapsed = Date.now() - startTime;
    if (elapsed <= 0) return '--';
    const rate = current / elapsed;
    const remaining = total - current;
    if (remaining <= 0) return '0s';
    const etaMs = remaining / rate;
    const seconds = Math.round(etaMs / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}m ${secs}s`;
  }, [current, total, startTime]);

  // 进度条字符
  const filled = Math.floor(width * percentage / 100);
  const empty = width - filled;

  return (
    <Box flexDirection="row" alignItems="center">
      <Text>{label}: </Text>
      <Text color="cyan">[</Text>
      <Text color="green">{'\u25A0'.repeat(filled)}</Text>
      <Text color="gray">{'\u25A1'.repeat(empty)}</Text>
      <Text color="cyan">]</Text>
      <Text color="white"> {percentage}%</Text>
      <Text color="gray"> ETA: {eta}</Text>
    </Box>
  );
};

module.exports = { default: ProgressBar };
