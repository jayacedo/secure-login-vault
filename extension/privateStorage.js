// Firefox has no storage.local.setAccessLevel. Keep pairing state in the
// extension origin's IndexedDB instead. Content scripts use the page's origin
// for IndexedDB and cannot access this database. This is not OS encryption.
(function (root) {
  function createPrivateStorage(factory = indexedDB) {
    const opened = new Promise((resolve, reject) => {
      const request = factory.open("slv-private-pairing", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("pairing");
      request.onerror = () => reject(new Error("Private pairing storage is unavailable"));
      request.onblocked = () => reject(new Error("Private pairing storage is blocked"));
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
    opened.catch(() => {});
    async function transaction(mode, action) {
      const db = await opened;
      return new Promise((resolve, reject) => {
        const tx = db.transaction("pairing", mode);
        let result;
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = () => reject(new Error("Private pairing storage failed"));
        action(tx.objectStore("pairing"), value => { result = value; });
      });
    }
    return {
      ready: opened.then(() => undefined),
      get: key => transaction("readonly", (store, done) => {
        const request = store.get(key);
        request.onsuccess = () => done({ [key]: request.result });
      }),
      set: values => transaction("readwrite", store => {
        for (const [key, value] of Object.entries(values)) store.put(value, key);
      }),
      remove: key => transaction("readwrite", store => store.delete(key))
    };
  }
  root.SLVPrivateStorage = { createPrivateStorage };
})(globalThis);
