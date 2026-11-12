const { contextBridge, ipcRenderer } = require("electron");
const channels = new Promise(resolve => ipcRenderer.once("slv:save-prompt-channels", (_event, value) => resolve(value)));
contextBridge.exposeInMainWorld("saveLoginPrompt", {
  load: async () => ipcRenderer.invoke((await channels).ready),
  respond: async (choice) => ipcRenderer.send((await channels).response, choice)
});
