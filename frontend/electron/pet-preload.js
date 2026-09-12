'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  let active = true;
  const listener = (_event, payload) => {
    if (active) callback(payload);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    if (!active) return;
    active = false;
    ipcRenderer.removeListener(channel, listener);
  };
}

function boundedText(value, label, max) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

contextBridge.exposeInMainWorld('electronAPI', Object.freeze({
  character: Object.freeze({
    get: () => ipcRenderer.invoke('character:getBundled'),
  }),
  pet: Object.freeze({
    hide: () => ipcRenderer.invoke('pet:hide'),
    dragStart: () => ipcRenderer.invoke('pet:drag-start'),
    dragMove: (delta) => ipcRenderer.invoke('pet:drag-move', {
      dx: Number(delta?.dx) || 0,
      dy: Number(delta?.dy) || 0,
    }),
    dragEnd: () => ipcRenderer.invoke('pet:drag-end'),
    onChatEvent: (callback) => subscribe('pet:chatEvent', callback),
    sendChat: (text) => ipcRenderer.invoke('pet:sendChat', {
      text: boundedText(text, 'pet chat text', 2000),
    }),
    cancelChat: () => ipcRenderer.invoke('pet:cancelChat'),
    listStickers: () => ipcRenderer.invoke('pet:listStickers'),
    importSticker: () => ipcRenderer.invoke('pet:importSticker'),
    sendSticker: (id) => ipcRenderer.invoke('pet:sendSticker', {
      id: boundedText(id, 'sticker id', 128),
    }),
  }),
}));
