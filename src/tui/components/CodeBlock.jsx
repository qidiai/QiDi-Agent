'use strict';

const React = require('react');
const { Box, Text } = require('ink');
const { useTheme } = require('../context/ThemeContext');

/**
 * 简单的语法高亮组件
 * 使用 highlight.js 进行代码高亮
 */
let hljs;
try {
  hljs = require('highlight.js');
} catch (e) {
  hljs = null;
}

// 简单的内置高亮（不依赖 highlight.js）
const builtinHighlight = (code, language) => {
  const lines = code.split('\n');
  const result = [];

  for (const line of lines) {
    // 简单的高亮规则
    let highlighted = line;

    // 注释 (// 或 # 开头)
    if (/^\s*(\/\/|#)/.test(line)) {
      highlighted = { type: 'comment', text: line };
    }
    // 字符串 ("... " 或 '...')
    else if (/"[^"]*"|'[^']*'/.test(line)) {
      highlighted = { type: 'string', text: line };
    }
    // 数字
    else if (/\b\d+(\.\d+)?\b/.test(line)) {
      highlighted = { type: 'number', text: line };
    }
    // 关键字
    else {
      const keywords = ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'throw', 'new', 'this', 'typeof', 'instanceof'];
      for (const kw of keywords) {
        if (new RegExp(`\\b${kw}\\b`).test(line)) {
          highlighted = { type: 'keyword', text: line };
          break;
        }
      }
    }

    result.push(highlighted);
  }

  return result;
};

const CodeBlock = ({ code, language = 'plaintext' }) => {
  const { theme } = useTheme();

  // 语法高亮
  const highlightedLines = React.useMemo(() => {
    if (!code) return [];

    if (hljs && hljs.getLanguage(language)) {
      try {
        const result = hljs.highlight(code, { language }).value;
        // 转换为行数组
        return result.split('\n').map((line, i) => ({
          type: 'highlighted',
          html: line
        }));
      } catch (e) {
        // 回退到内置高亮
        return builtinHighlight(code, language);
      }
    }

    // 使用内置高亮
    return builtinHighlight(code, language);
  }, [code, language]);

  const displayLines = highlightedLines.slice(0, 100); // 最多显示100行

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {/* 行号 + 代码 */}
      {displayLines.map((line, i) => {
        // highlight.js 生成的 HTML
        if (line.type === 'highlighted') {
          return (
            <Box key={i} flexDirection="row">
              <Text color="gray" width={4}>
                {String(i + 1).padStart(3, ' ')} │
              </Text>
              <Text>{parseHtmlToInk(line.html, theme)}</Text>
            </Box>
          );
        }

        // 内置高亮
        const colorMap = {
          keyword: theme.highlight.keyword,
          string: theme.highlight.string,
          number: theme.highlight.number,
          comment: theme.highlight.comment,
          function: theme.highlight.function
        };
        const color = colorMap[line.type] || theme.text.normal;

        return (
          <Box key={i} flexDirection="row">
            <Text color="gray" width={4}>
              {String(i + 1).padStart(3, ' ')} │
            </Text>
            <Text color={color}>{line.text || line}</Text>
          </Box>
        );
      })}

      {highlightedLines.length > 100 && (
        <Box marginTop={1}>
          <Text dimColor>... 还有 {highlightedLines.length - 100} 行未显示</Text>
        </Box>
      )}
    </Box>
  );
};

// 简单的 HTML 转义序列解析（用于 highlight.js 输出）
function parseHtmlToInk(html, theme) {
  if (!html) return '';

  // 替换基本的 HTML 标签
  return html
    .replace(/<span class="hljs-keyword">/g, '')
    .replace(/<span class="hljs-string">/g, '')
    .replace(/<span class="hljs-number">/g, '')
    .replace(/<span class="hljs-comment">/g, '')
    .replace(/<span class="hljs-function">/g, '')
    .replace(/<span class="hljs-title">/g, '')
    .replace(/<span class="hljs-params">/g, '')
    .replace(/<span class="hljs-built_in">/g, '')
    .replace(/<span class="hljs-literal">/g, '')
    .replace(/<span class="hljs-attr">/g, '')
    .replace(/<span class="hljs-selector-tag">/g, '')
    .replace(/<span class="hljs-name">/g, '')
    .replace(/<span class="hljs-selector-id">/g, '')
    .replace(/<span class="hljs-selector-class">/g, '')
    .replace(/<span class="hljs-type">/g, '')
    .replace(/<span class="hljs-variable">/g, '')
    .replace(/<span class="hljs-template-variable">/g, '')
    .replace(/<span class="hljs-tag">/g, '')
    .replace(/<span class="hljs-symbol">/g, '')
    .replace(/<span class="hljs-meta">/g, '')
    .replace(/<span class="hljs-selector-attr">/g, '')
    .replace(/<span class="hljs-selector-pseudo">/g, '')
    .replace(/<span class="hljs-addition">/g, '')
    .replace(/<span class="hljs-deletion">/g, '')
    .replace(/<\/span>/g, '');
}

module.exports = { default: CodeBlock };
