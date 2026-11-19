'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'app:info', 'win:min', 'win:max', 'win:close',
  'versions:manifest', 'versions:installed', 'versions:delete', 'loaders:support',
  'game:play', 'game:stop', 'game:state', 'game:log',
  'settings:get', 'settings:set',
  'accounts:list', 'accounts:addOffline', 'accounts:select', 'accounts:remove',
  'auth:microsoft', 'auth:cancel',
  'java:list', 'java:browse',
  'folder:open', 'link:open',
]);
const EVENTS = new Set(['progress', 'state', 'log', 'auth:code', 'toast']);

contextBridge.exposeInMainWorld('api', {
  invoke: (ch, ...args) => {
    if (!INVOKE.has(ch)) return Promise.reject(new Error('Недопустимый канал: ' + ch));
    return ipcRenderer.invoke(ch, ...args);
  },
  on: (ch, cb) => {
    if (!EVENTS.has(ch)) throw new Error('Недопустимое событие: ' + ch);
    const f = (_e, d) => cb(d);
    ipcRenderer.on(ch, f);
    return () => ipcRenderer.removeListener(ch, f);
  },
});
