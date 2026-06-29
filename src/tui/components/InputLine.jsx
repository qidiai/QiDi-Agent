'use strict';

const React = require('react');
const { Box, Text } = require('ink');
const { useTheme } = require('../context/ThemeContext');
const { useKeyboard } = require('../hooks/useKeyboard');
const { useFuzzyMatch } = require('../hooks/useFuzzyMatch');

const COMMANDS = [
  'scan', 'tools', 'status', 'mode privacy', 'mode quality',
  'provider ollama', 'provider openai', 'provider anthropic',
  'run', 'tasks', 'reports', 'report', 'context', 'ctx',
  'ls', 'view', 'pwd', 'history', 'reset', 'clear', 'cls',
  'help', 'exit', 'quit', 'q'
];

const InputLine = ({ session, onSubmit, onModeChange }) => {
  const { theme } = useTheme();
  const [input, setInput] = React.useState('');
  const [cursorPosition, setCursorPosition] = React.useState(0);
  const [showSuggestions, setShowSuggestions] = React.useState(false);
  const [selectedSuggestion, setSelectedSuggestion] = React.useState(0);

  const { match, addCandidates } = useFuzzyMatch(COMMANDS);
  const suggestions = React.useMemo(() => match(input, 5), [input, match]);

  // Tab 自动补全
  useKeyboard({
    onTab: () => {
      if (suggestions.length > 0) {
        const selected = suggestions[selectedSuggestion] || suggestions[0];
        setInput(selected);
        setCursorPosition(selected.length);
        setShowSuggestions(false);
      }
    },
    onArrowUp: () => {
      if (showSuggestions && suggestions.length > 0) {
        setSelectedSuggestion(prev =>
          prev > 0 ? prev - 1 : suggestions.length - 1
        );
      }
    },
    onArrowDown: () => {
      if (showSuggestions && suggestions.length > 0) {
        setSelectedSuggestion(prev =>
          prev < suggestions.length - 1 ? prev + 1 : 0
        );
      }
    },
    onEnter: () => {
      if (input.trim()) {
        onSubmit && onSubmit(input.trim());
        setInput('');
        setCursorPosition(0);
        setShowSuggestions(false);
        setSelectedSuggestion(0);
      }
    },
    onEscape: () => {
      setShowSuggestions(false);
      setSelectedSuggestion(0);
    }
  });

  // 输入变化时显示建议
  React.useEffect(() => {
    if (input.length > 0) {
      setShowSuggestions(true);
      setSelectedSuggestion(0);
    } else {
      setShowSuggestions(false);
    }
  }, [input]);

  // 处理键盘输入
  const handleKeyPress = (key) => {
    if (key === '\u7F') {
      // Backspace
      setInput(prev => prev.slice(0, -1));
      setCursorPosition(prev => Math.max(0, prev - 1));
    } else if (key.length === 1 && !key.match(/[\x00-\x1F]/)) {
      const newInput = input.slice(0, cursorPosition) + key + input.slice(cursorPosition);
      setInput(newInput);
      setCursorPosition(prev => prev + 1);
    }
  };

  // 渲染输入行
  const renderInputLine = () => {
    const prompt = theme.text.cyan + '> ' + theme.text.normal;
    const beforeCursor = input.slice(0, cursorPosition);
    const cursor = theme.text.inverse + (input[cursorPosition] || ' ') + theme.text.normal;
    const afterCursor = input.slice(cursorPosition + 1);

    return (
      <Box flexDirection="row">
        <Text bold color="cyan">qidi&gt; </Text>
        <Text>{beforeCursor}</Text>
        <Text inverse>{cursor}</Text>
        <Text>{afterCursor}</Text>
      </Box>
    );
  };

  // 渲染建议列表
  const renderSuggestions = () => {
    if (!showSuggestions || suggestions.length === 0) return null;

    return (
      <Box flexDirection="column" marginTop={1}>
        {suggestions.map((s, i) => (
          <Box key={i} flexDirection="row">
            <Text color="gray" width={3}>
              {i === selectedSuggestion ? '> ' : '   '}
            </Text>
            <Text color={i === selectedSuggestion ? theme.text.cyan : theme.text.dim}>
              {s}
            </Text>
          </Box>
        ))}
      </Box>
    );
  };

  return (
    <Box flexDirection="column" padding={1} borderTopWidth={1} borderColor={theme.border}>
      {renderInputLine()}
      {renderSuggestions()}
    </Box>
  );
};

module.exports = { default: InputLine };
