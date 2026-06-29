/**
 * Qidi Agent TUI 主题系统
 * 支持深色/浅色主题
 */

const themes = {
  dark: {
    name: 'dark',
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    border: '#3c3c3c',
    cursor: '#ffffff',
    text: {
      normal: '#d4d4d4',
      dim: '#6a6a6a',
      cyan: '#4ec9b0',
      green: '#6a9955',
      yellow: '#dcdcaa',
      red: '#f14c4c',
      blue: '#569cd6',
      magenta: '#c586c0',
      white: '#ffffff',
      black: '#000000'
    },
    highlight: {
      keyword: '#569cd6',
      string: '#ce9178',
      number: '#b5cea8',
      comment: '#6a9955',
      function: '#dcdcaa',
      variable: '#9cdcfe',
      type: '#4ec9b0',
      operator: '#d4d4d4'
    },
    status: {
      running: '#4ec9b0',
      completed: '#6a9955',
      failed: '#f14c4c',
      pending: '#6a6a6a',
      paused: '#dcdcaa'
    }
  },
  light: {
    name: 'light',
    background: '#ffffff',
    foreground: '#333333',
    border: '#cccccc',
    cursor: '#000000',
    text: {
      normal: '#333333',
      dim: '#888888',
      cyan: '#16825d',
      green: '#388a34',
      yellow: '#795e26',
      red: '#d32f2f',
      blue: '#0000ff',
      magenta: '#a31515',
      white: '#ffffff',
      black: '#000000'
    },
    highlight: {
      keyword: '#0000ff',
      string: '#a31515',
      number: '#098658',
      comment: '#008000',
      function: '#795e26',
      variable: '#001080',
      type: '#16825d',
      operator: '#333333'
    },
    status: {
      running: '#16825d',
      completed: '#388a34',
      failed: '#d32f2f',
      pending: '#888888',
      paused: '#795e26'
    }
  }
};

module.exports = { themes, defaultTheme: themes.dark };
