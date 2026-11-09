const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("secureLoginVault", {
  appName: "Secure Login Vault",
  phase: "UI Polish",

  auth: {
    getState:     ()        => ipcRenderer.invoke("vault:get-state"),
    createVault:  (payload) => ipcRenderer.invoke("vault:create", payload),
    unlockVault:  (payload) => ipcRenderer.invoke("vault:unlock", payload),
    lockVault:    ()        => ipcRenderer.invoke("vault:lock"),
    // Fired by the main process after it has already locked the vault
    // (inactivity or window backgrounded); the renderer only updates its UI.
    onAutoLocked: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("vault:auto-locked", handler);
      return () => ipcRenderer.removeListener("vault:auto-locked", handler);
    }
  },

  vault: {
    getDashboardData: () => ipcRenderer.invoke("vault:get-dashboard-data")
  },

  credentials: {
    getAll:         ()          => ipcRenderer.invoke("vault:get-credentials"),
    getAllForExport: ()         => ipcRenderer.invoke("vault:get-credentials-for-export"),
    getOne:         (id)        => ipcRenderer.invoke("vault:get-credential", id),
    add:            (data)      => ipcRenderer.invoke("vault:add-credential", data),
    update:         (id, d)     => ipcRenderer.invoke("vault:update-credential", id, d),
    remove:         (id)        => ipcRenderer.invoke("vault:delete-credential", id),
    removeByGroups: (groupNames) => ipcRenderer.invoke("vault:delete-credentials-by-groups", groupNames),
    toggleFavorite: (id)        => ipcRenderer.invoke("vault:toggle-favorite", id),
    getCategories:  ()          => ipcRenderer.invoke("vault:get-categories"),
    search:         (options)   => ipcRenderer.invoke("vault:search-credentials", options)
  },

  categories: {
    getAllWithUsage: ()                       => ipcRenderer.invoke("vault:get-categories-with-usage"),
    add:             (name)                   => ipcRenderer.invoke("vault:add-category", name),
    rename:          (currentName, newName)   => ipcRenderer.invoke("vault:rename-category", currentName, newName),
    remove:          (name, reassignTo)       => ipcRenderer.invoke("vault:delete-category", name, reassignTo)
  },

  groups: {
    getAll:          ()                       => ipcRenderer.invoke("vault:get-groups"),
    getAllWithUsage: ()                       => ipcRenderer.invoke("vault:get-groups-with-usage"),
    add:             (name)                   => ipcRenderer.invoke("vault:add-group", name),
    rename:          (currentName, newName)   => ipcRenderer.invoke("vault:rename-group", currentName, newName),
    remove:          (name)                   => ipcRenderer.invoke("vault:delete-group", name),
    getActive:       ()                       => ipcRenderer.invoke("vault:get-active-group"),
    setActive:       (name)                   => ipcRenderer.invoke("vault:set-active-group", name)
  },

  login: {
    // Opens the saved entry's site in a secure window and fills the login form.
    open: (payload) => ipcRenderer.invoke("vault:open-login-window", payload)
  },

  clients: {
    getAll:         ()          => ipcRenderer.invoke("vault:get-clients"),
    getOne:         (id)        => ipcRenderer.invoke("vault:get-client", id),
    add:            (data)      => ipcRenderer.invoke("vault:add-client", data),
    update:         (id, d)     => ipcRenderer.invoke("vault:update-client", id, d),
    remove:         (id)        => ipcRenderer.invoke("vault:delete-client", id),
    toggleFavorite: (id)        => ipcRenderer.invoke("vault:toggle-client-favorite", id),
    search:         (options)   => ipcRenderer.invoke("vault:search-clients", options)
  },

  importExport: {
    pickImportFile:   ()                       => ipcRenderer.invoke("vault:pick-import-file"),
    pickExportPath:   (opts)                    => ipcRenderer.invoke("vault:pick-export-path", opts),
    writeExportFile:  (opts)                    => ipcRenderer.invoke("vault:write-export-file", opts),
    createBackup:     (opts)                    => ipcRenderer.invoke("vault:create-backup", opts),
    pickRestoreFile:  ()                        => ipcRenderer.invoke("vault:pick-restore-file"),
    restoreBackup:    (opts)                    => ipcRenderer.invoke("vault:restore-backup", opts)
  },

  settings: {
    changeMasterPassword: (payload) => ipcRenderer.invoke("vault:change-master-password", payload),
    setPasswordHint:      (payload) => ipcRenderer.invoke("vault:set-password-hint", payload),
    getExtensionBridge:   ()        => ipcRenderer.invoke("vault:get-extension-bridge"),
    setExtensionBridge:   (payload) => ipcRenderer.invoke("vault:set-extension-bridge", payload),
    setExtensionAskBeforeFill: (payload) => ipcRenderer.invoke("vault:set-extension-ask-before-fill", payload),
    getExtensionPairing:  ()        => ipcRenderer.invoke("vault:get-extension-pairing"),
    startExtensionPairing: ()       => ipcRenderer.invoke("vault:start-extension-pairing"),
    cancelExtensionPairing: ()      => ipcRenderer.invoke("vault:cancel-extension-pairing"),
    unpairExtension:      ()        => ipcRenderer.invoke("vault:unpair-extension"),
    createRecoveryKey:    (payload) => ipcRenderer.invoke("vault:create-recovery-key", payload),
    resetWithRecoveryKey: (payload) => ipcRenderer.invoke("vault:reset-with-recovery-key", payload),
    getAppInfo:           ()        => ipcRenderer.invoke("app:get-info"),
    pickFolder:           ()        => ipcRenderer.invoke("app:pick-folder"),
    setLockPolicy:        (policy)  => ipcRenderer.invoke("vault:set-lock-policy", policy),
    noteActivity:         ()        => ipcRenderer.send("vault:activity")
  },

  branding: {
    setWindowTitle: (title) => ipcRenderer.invoke("app:set-window-title", title),
    setWindowIcon: (dataUri) => ipcRenderer.invoke("app:set-window-icon", dataUri)
  }
});
