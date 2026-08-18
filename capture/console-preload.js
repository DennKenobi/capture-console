// Console preload — narrow, promise-based bridge; renderer stays node-free.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cc', {
	state: () => ipcRenderer.invoke('state'),
	urls: (source, defaults) => ipcRenderer.invoke('urls', source, defaults),
	saveConfig: config => ipcRenderer.invoke('save-config', config),
	command: line => ipcRenderer.invoke('command', line),
	startSupervisor: () => ipcRenderer.invoke('start-supervisor'),
});
