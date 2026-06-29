'use strict';

const React = require('react');
const { themes } = require('../styles/themes');

/**
 * 主题 Hook
 *
 * 使用方式:
 * const { theme, themeName, toggleTheme } = useTheme();
 */
const useTheme = () => {
  const [themeName, setThemeName] = React.useState('dark');
  const theme = themes[themeName] || themes.dark;

  const toggleTheme = React.useCallback(() => {
    setThemeName(prev => prev === 'dark' ? 'light' : 'dark');
  }, []);

  const setTheme = React.useCallback((name) => {
    if (themes[name]) {
      setThemeName(name);
    }
  }, []);

  return {
    theme,
    themeName,
    toggleTheme,
    setTheme
  };
};

module.exports = { useTheme };
