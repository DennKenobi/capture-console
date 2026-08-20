// Console preload — narrow, promise-based bridge; renderer stays node-free.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cc', {
	state: () => ipcRenderer.invoke('state'),
	urls: (source, defaults) => ipcRenderer.invoke('urls', source, defaults),
	saveConfig: config => ipcRenderer.invoke('save-config', config),
	command: line => ipcRenderer.invoke('command', line),
	startSupervisor: () => ipcRenderer.invoke('start-supervisor'),
	previewToggle: (scope, on) => ipcRenderer.invoke('preview-toggle', scope, on),
	audioMute: (player, on) => ipcRenderer.invoke('audio-mute', player, on),
	audioSolo: player => ipcRenderer.invoke('audio-solo', player),
	popoutToggle: player => ipcRenderer.invoke('popout-toggle', player),
	audioDevices: () => ipcRenderer.invoke('audio-devices'),
	sceneNew: () => ipcRenderer.invoke('scene-new'),
	sceneOpen: () => ipcRenderer.invoke('scene-open'),
	sceneSaveAs: () => ipcRenderer.invoke('scene-saveas'),
	openHelp: () => ipcRenderer.invoke('open-help'),
	onPreviewFrame: cb => ipcRenderer.on('preview-frame', (e, frame) => cb(frame)),
	onMeterUpdate: cb => ipcRenderer.on('meter-update', (e, update) => cb(update)),
});
