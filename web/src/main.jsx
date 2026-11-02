import React from 'react';
import { createRoot } from 'react-dom/client';
import 'mdui/mdui.css';
import 'mdui';
import * as zhCnLocale from 'mdui/locales/zh-cn.js';
import { loadLocale, setLocale, setTheme } from 'mdui';

import './styles.css';
import App from './App.jsx';

// 组件内置文案（文本框校验、对话框按钮等）走 mdui 的本地化
loadLocale(async () => zhCnLocale);
setLocale('zh-cn').catch(() => {});

const THEME_KEY = 'fuckds-admin-theme';
const savedTheme = localStorage.getItem(THEME_KEY) || 'auto';
setTheme(savedTheme);

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App initialTheme={savedTheme} />
  </React.StrictMode>,
);
