// Browser API stand-ins shared by worker tests. No real browser or user storage.
function addOfferApis(chrome, { tab = { id: 7, url: "https://example.com/login" }, allowed = false } = {}) {
  const event = () => {
    const listeners = [];
    return { addListener(fn) { listeners.push(fn); }, emit(...args) { listeners.forEach(fn => fn(...args)); } };
  };
  const state = { tab, allowed, registered: [], notices: [], access: "", requests: [] };
  chrome.runtime.getURL = file => `chrome-extension://${chrome.runtime.id}/${file}`;
  chrome.storage.local.setAccessLevel = async ({ accessLevel }) => { state.access = accessLevel; };
  const sessionStore = {};
  chrome.storage.session = {
    setAccessLevel: async () => {},
    get: async key => ({ [key]: sessionStore[key] }),
    set: async values => Object.assign(sessionStore, values),
    remove: async key => { delete sessionStore[key]; }
  };
  chrome.permissions = {
    contains: async () => state.allowed,
    request: async request => { state.requests.push(request); return state.allowed; },
    onRemoved: event()
  };
  const query = chrome.tabs.query;
  chrome.tabs.query = (options, callback) => callback ? query(options, callback) : Promise.resolve(state.tab ? [state.tab] : []);
  chrome.tabs.get = async id => { if (!state.tab || state.tab.id !== id) throw new Error("No tab"); return state.tab; };
  chrome.tabs.sendMessage = async (id, message) => { state.notices.push({ id, message }); };
  chrome.tabs.onRemoved = event();
  chrome.tabs.onUpdated = event();
  chrome.scripting.getRegisteredContentScripts = async ({ ids } = {}) => state.registered.filter(script => !ids || ids.includes(script.id));
  chrome.scripting.registerContentScripts = async scripts => { state.registered.push(...scripts); };
  chrome.scripting.unregisterContentScripts = async ({ ids } = {}) => { state.registered = state.registered.filter(script => ids && !ids.includes(script.id)); };
  return state;
}
module.exports = { addOfferApis };
