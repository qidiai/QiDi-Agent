'use strict';

const React = require('react');
const { themes } = require('../styles/themes');

const ThemeContext = React.createContext({
  theme: themes.dark,
  themeName: 'dark',
  toggleTheme: () => {},
  setTheme: () => {}
});

const useTheme = () => React.useContext(ThemeContext);

const ThemeProvider = ({ children, initialTheme = 'dark' }) => {
  const [themeName, setThemeName] = React.useState(initialTheme);
  const theme = themes[themeName] || themes.dark;

  const toggleTheme = React.useCallback(() => {
    setThemeName(prev => prev === 'dark' ? 'light' : 'dark');
  }, []);

  const setTheme = React.useCallback((name) => {
    if (themes[name]) {
      setThemeName(name);
    }
  }, []);

  const value = React.useMemo(() => ({
    theme,
    themeName,
    toggleTheme,
    setTheme
  }), [theme, themeName, toggleTheme, setTheme]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
};

module.exports = { ThemeContext, ThemeProvider, useTheme };
