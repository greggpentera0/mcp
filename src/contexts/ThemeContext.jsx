import React, { createContext, useCallback, useContext, useMemo, useState, useEffect } from 'react';

const ThemeContext = createContext();
const THEME_STORAGE_KEY = 'themeMode';
const LEGACY_THEME_STORAGE_KEY = 'theme';
const THEME_MODES = new Set(['system', 'light', 'dark']);

const getSystemPrefersDark = () => (
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches
);

const readThemeMode = () => {
  try {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    return THEME_MODES.has(savedTheme) ? savedTheme : 'system';
  } catch {
    return 'system';
  }
};

const updateBrowserThemeMetadata = (isDarkMode) => {
  const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
  if (statusBarMeta) {
    statusBarMeta.setAttribute('content', isDarkMode ? 'black-translucent' : 'default');
  }

  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta) {
    themeColorMeta.setAttribute('content', isDarkMode ? '#0c1117' : '#ffffff');
  }
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

export const ThemeProvider = ({ children }) => {
  const [themeMode, setThemeModeState] = useState(readThemeMode);
  const [systemPrefersDark, setSystemPrefersDark] = useState(getSystemPrefersDark);
  const isDarkMode = themeMode === 'system' ? systemPrefersDark : themeMode === 'dark';

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    updateBrowserThemeMetadata(isDarkMode);
  }, [isDarkMode]);

  useEffect(() => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, themeMode);
      localStorage.setItem(LEGACY_THEME_STORAGE_KEY, themeMode);
    } catch {
      // Local storage can be unavailable in private or embedded browser contexts.
    }
  }, [themeMode]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event) => setSystemPrefersDark(event.matches);

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  const setThemeMode = useCallback((nextMode) => {
    if (!THEME_MODES.has(nextMode)) {
      return;
    }

    setThemeModeState(nextMode);
  }, []);

  const toggleDarkMode = useCallback(() => {
    setThemeModeState((currentMode) => {
      const currentIsDark = currentMode === 'system' ? getSystemPrefersDark() : currentMode === 'dark';
      return currentIsDark ? 'light' : 'dark';
    });
  }, []);

  const value = useMemo(() => ({
    isDarkMode,
    themeMode,
    effectiveTheme: isDarkMode ? 'dark' : 'light',
    setThemeMode,
    toggleDarkMode,
  }), [isDarkMode, setThemeMode, themeMode, toggleDarkMode]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
};
