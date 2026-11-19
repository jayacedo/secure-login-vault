const assert = require("assert/strict"), fs = require("fs"), path = require("path");
const { app, BrowserWindow, clipboard, dialog, powerMonitor } = require("electron");
const { testTempRoot } = require("./testTemp");
const root = fs.mkdtempSync(path.join(testTempRoot(), "notes-app-"));
console.log(`Synthetic Notes profile: ${root}`);
for (const name of ["userData", "sessionData", "temp", "logs"]) {
  const dir = path.join(root, name); fs.mkdirSync(dir); app.setPath(name, dir);
}
app.setPath("appData", root); process.env.APPDATA = root; process.env.LOCALAPPDATA = root;
process.env.TEMP = root; process.env.TMP = root;
powerMonitor.getSystemIdleState = () => "active";
process.env.SLV_PIPE_USER = `notes-${process.pid}`;
// In-memory clipboard only: never call the original operating-system methods.
let copiedText = "", copiedHtml = "", copyCount = 0;
clipboard.readText = () => copiedText;
clipboard.writeText = text => { copiedText = text; copiedHtml = ""; copyCount++; };
clipboard.clear = () => { copiedText = ""; copiedHtml = ""; };
clipboard.write = clipboard.readHTML = clipboard.writeHTML = () => { throw Error("Real clipboard forbidden"); };
dialog.showOpenDialog = dialog.showSaveDialog = async () => ({ canceled: true });
require("../src/services/browserSetup").createBrowserSetup = () => ({ status: async () => ({ supported: false, ready: false }) });
require("../src/main");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 160; i++) { if (await fn()) return; await sleep(50); } throw Error("Synthetic Notes UI timed out"); }
async function main() {
  await app.whenReady(); await until(() => BrowserWindow.getAllWindows().length);
  const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.show();
  if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once("did-finish-load", resolve));
  const run = async code => { try { return await win.webContents.executeJavaScript(code); } catch (error) { throw Error(`Synthetic UI step ${code.slice(0, 100)}: ${error.message}`); } };
  const api = code => run(`window.secureLoginVault.${code}`);
  const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const input = (selector, value) => run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const password = "Synthetic notes UI passphrase only";
  await api(`auth.createVault(${JSON.stringify({ masterPassword: password, confirmPassword: password })})`);
  await run("initAuth();setPref(PREF_BACKGROUND_LOCK,'off');startAutoLockWatcher()");
  await until(() => run("!!document.querySelector('#open-notes-btn')"));
  await click("#open-notes-btn");
  await until(() => run("document.querySelector('#notes-count').textContent==='No matching notes'"));
  await click("#add-note-btn");
  await input("#note-title", "Synthetic project checklist");
  await input("#note-body", "Synthetic notes only.\nReview the demo layout.\nCheck the fake checklist.");
  await click("#note-save");
  await until(() => run("!!document.querySelector('#note-heading') && !notesView.busy"));
  assert.equal(await run("document.querySelector('#note-heading').textContent"), "Synthetic project checklist");
  const syntheticNote = "Synthetic notes only.\nReview the demo layout.\nCheck the fake checklist.";
  const copySelection = (start, end) => run(`(() => {
    const node = document.querySelector('#note-reading-body').firstChild;
    const selection = window.getSelection(); selection.removeAllRanges();
    const range = document.createRange(); range.setStart(node, ${start}); range.setEnd(node, ${end}); selection.addRange(range);
    const event = new Event('copy', { bubbles: true, cancelable: true });
    document.dispatchEvent(event); return event.defaultPrevented;
  })()`);
  copiedHtml = '<span style="background:#123">Old synthetic rich text</span>';
  assert.equal(await copySelection(0, syntheticNote.length), true, "native rich-text copy is suppressed");
  await until(() => copyCount === 1);
  assert.equal(copiedText, syntheticNote, "multiline text is unchanged");
  assert.equal(copiedHtml, "", "plain-text write replaces rich clipboard formats");
  assert.equal(await copySelection(10, 28), true);
  await until(() => copyCount === 2);
  assert.equal(copiedText, syntheticNote.slice(10, 28), "only the selected portion is copied");
  assert.equal(await run(`(() => {
    const input = document.querySelector('#notes-search'); input.focus(); input.value = 'Synthetic query'; input.select();
    const event = new Event('copy', { bubbles: true, cancelable: true }); input.dispatchEvent(event);
    input.value = ''; input.blur(); return event.defaultPrevented;
  })()`), false, "search input copy is not replaced by an old note selection");
  assert.equal(await run(`(() => {
    const selection = window.getSelection(); selection.removeAllRanges();
    const event = new Event('copy', { bubbles: true, cancelable: true }); document.dispatchEvent(event); return event.defaultPrevented;
  })()`), false, "empty selections keep default behavior");
  assert.equal(await run(`(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('#dashboard-title'));
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const event = new Event('copy', { bubbles: true, cancelable: true }); document.dispatchEvent(event); selection.removeAllRanges(); return event.defaultPrevented;
  })()`), false, "copy outside the note is unchanged");
  await click("#note-favorite"); await until(() => run("notesView.note.favorite===1 && !notesView.busy"));
  await click("#notes-favorites"); await until(() => run("notesView.favorites && document.querySelectorAll('[data-note-id]').length===1"));
  await click("#notes-favorites");
  await click("#note-edit"); await input("#note-body", "Unsaved synthetic edit");
  await run("window.confirm=()=>false;void 0");
  await click("#notes-open-vault");
  assert.equal(await run("document.querySelector('#note-body').value"), "Unsaved synthetic edit");
  await click("#note-cancel"); assert.equal(await run("notesView.editing"), true);
  await run("window.confirm=()=>true;void 0"); await click("#note-cancel");
  assert.equal(await run("document.querySelector('#note-reading-body').textContent.includes('Unsaved')"), false);
  const malicious = '<img src=x onerror="window.noteInjection=true">';
  const added = await api(`notes.add(${JSON.stringify({ title: malicious, body: malicious + "\nSynthetic XSS test" })})`);
  assert.equal(added.ok, true);
  await click("#notes-refresh"); await until(() => run("document.querySelectorAll('[data-note-id]').length===2"));
  await click(`[data-note-id="${added.result.id}"]`); await until(() => run(`notesView.note?.id===${added.result.id}`));
  assert.equal(await run("document.querySelector('#note-heading').textContent"), malicious);
  assert.equal(await run("!!document.querySelector('#notes-workspace img') || !!window.noteInjection"), false);
  await input("#notes-search", "<img");
  await until(() => run("document.querySelectorAll('#notes-list mark.search-highlight').length===2"));
  assert.equal(await run("!!document.querySelector('#notes-workspace img') || !!window.noteInjection"), false, "highlighted markup remains text");
  assert.deepEqual(await run("Array.from(document.querySelectorAll('#notes-list mark'), el=>el.textContent)"), ["<img", "<img"]);
  // Shared Vault/Notes highlighting treats punctuation literally and never
  // searches the HTML entities introduced by escaping.
  assert.deepEqual(await run(`(() => {
    const render = (text, query) => { const el=document.createElement('div'); el.innerHTML=highlightMatch(text,query); return {text:el.textContent, matches:Array.from(el.querySelectorAll('mark'),m=>m.textContent)}; };
    return [render('A & sample', 'amp'), render('a.b [x] aXb', 'a.b'), render('<tag> & "quoted"', '&'), render('Repeat REPEAT', ' repeat ')];
  })()`), [
    { text: "A & sample", matches: ["amp"] },
    { text: "a.b [x] aXb", matches: ["a.b"] },
    { text: '<tag> & "quoted"', matches: ["&"] },
    { text: "Repeat REPEAT", matches: ["Repeat", "REPEAT"] }
  ]);
  await input("#notes-search", "");
  await until(() => run("document.querySelectorAll('[data-note-id]').length===2 && !document.querySelector('#notes-list mark')"));
  await click("#note-delete"); assert.equal(await run("document.querySelector('#note-delete-confirm').hidden"), false);
  await click("#note-delete-cancel");
  assert.equal((await api(`notes.getOne(${added.result.id})`)).ok, true);
  await click("#note-delete"); await click("#note-delete-now"); await until(() => run("!notesView.busy && notesView.note===null"));
  assert.equal((await api(`notes.getOne(${added.result.id})`)).ok, false);
  for (let i = 0; i < 53; i++) assert.equal((await api(`notes.add(${JSON.stringify({ title: `Synthetic note ${String(i).padStart(2, "0")}`, body: "Dummy planning notes.\nA second line for the reading pane." })})`)).ok, true);
  await click("#notes-refresh"); await until(() => run("document.querySelectorAll('[data-note-id]').length===50"));
  await click("#notes-next"); await until(() => run("document.querySelectorAll('[data-note-id]').length===4"));
  assert.equal(await run("document.querySelector('#notes-next').disabled"), true);
  assert.equal(await run("getComputedStyle(document.querySelector('#notes-next')).cursor"), "default");
  await input("#notes-search", "project checklist"); await until(() => run("document.querySelectorAll('[data-note-id]').length===1"));
  assert.equal(await run("document.querySelector('#notes-list strong mark')?.textContent"), "project checklist", "phrase highlighted in title");
  await input("#notes-search", "SYNTH");
  await until(() => run("document.querySelectorAll('#notes-list strong mark').length===50"));
  assert.equal(await run("Array.from(document.querySelectorAll('#notes-list mark')).every(el=>el.textContent.toLowerCase()==='synth')"), true, "partial matches preserve original case");
  await input("#notes-search", "check");
  await until(() => run("document.querySelectorAll('[data-note-id]').length===1 && document.querySelectorAll('#notes-list .note-snippet mark').length===2"));
  assert.deepEqual(await run("Array.from(document.querySelectorAll('#notes-list .note-snippet mark'),el=>el.textContent)"), ["Check", "check"]);
  await click("[data-note-id]"); await until(() => run("notesView.note?.title==='Synthetic project checklist'"));
  assert.equal(await run("!!document.querySelector('#note-detail mark')"), false, "reading pane remains plain text");
  await input("#notes-search", ""); await until(() => run("document.querySelectorAll('[data-note-id]').length===50"));
  assert.equal(await run("!!document.querySelector('#notes-list mark')"), false, "clearing search removes highlights");
  for (const [width, palette, theme] of [[1400, "forest", "dark"], [980, "coffee", "dark"], [1100, "", "light"]]) {
    win.setSize(width, 800);
    await run(`document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)});document.documentElement.setAttribute('data-palette',${JSON.stringify(palette)});document.querySelector('#notes-sort').value='title-asc';document.querySelector('#notes-sort').dispatchEvent(new Event('change'))`);
    await sleep(200);
    const overflow = await run("document.documentElement.scrollWidth>innerWidth+1");
    assert.equal(overflow, false, `No overflow at ${width}`);
    assert.equal(await run("document.documentElement.scrollHeight<=innerHeight+1"), true, "Notes panes scroll within the window");
    assert.equal(await run("document.querySelector('#notes-open-vault').getClientRects().length>0"), true, "Workspace navigation stays visible");
    assert.equal(await run("document.querySelector('#notes-next').getBoundingClientRect().bottom<=innerHeight"), true, "Pagination stays on screen");
    fs.writeFileSync(path.join(root, `notes-${width}.png`), (await win.webContents.capturePage()).toPNG());
  }
  await click("#note-edit");
  win.setSize(980, 640);
  await run("document.documentElement.setAttribute('data-text-size','large')");
  await sleep(100);
  assert.equal(await run("document.documentElement.scrollWidth<=innerWidth+1 && document.documentElement.scrollHeight<=innerHeight+1"), true, "Large-text editor fits minimum window");
  await run("document.querySelector('#note-save').scrollIntoView({block:'nearest'})");
  assert.equal(await run("document.querySelector('#note-save').getBoundingClientRect().bottom<=innerHeight"), true, "Save remains reachable in editor");
  fs.writeFileSync(path.join(root, "notes-editor-minimum.png"), (await win.webContents.capturePage()).toPNG());
  await input("#note-body", "Synthetic saved edit\nA second paragraph.");
  await click("#note-save"); await until(() => run("!notesView.busy && !!document.querySelector('#note-reading-body')"));
  assert.equal(await run("document.querySelector('#note-reading-body').textContent"), "Synthetic saved edit\nA second paragraph.");
  await run("document.documentElement.setAttribute('data-text-size','default')");
  await click("#notes-open-clients"); await until(() => run("!!document.querySelector('#client-search')"));
  await click("#open-notes-btn"); await until(() => run("document.querySelectorAll('[data-note-id]').length>0"));
  await click("[data-note-id]"); await until(() => run("!!document.querySelector('#note-heading')"));
  await click("#note-edit"); await input("#note-body", "Discard this synthetic draft when locking");
  await click("#lock-vault-button"); await until(() => run("!!document.querySelector('#master-password')"));
  assert.equal(await run("notesView===null && !document.querySelector('#note-body')"), true);
  assert.equal((await api("notes.list({})")).ok, false, "IPC rejects notes while locked");
  await until(() => copiedText === "");
  await api(`auth.unlockVault(${JSON.stringify({ masterPassword: password })})`);
  await run("initAuth()"); await until(() => run("!!document.querySelector('#open-notes-btn')"));
  await click("#open-notes-btn"); await until(() => run("document.querySelectorAll('[data-note-id]').length>0"));
  // A late note response must never repopulate the renderer after locking.
  await run("openNote(Number(document.querySelector('[data-note-id]').dataset.noteId));handleLockVault()");
  await until(() => run("!!document.querySelector('#master-password')")); await sleep(250);
  assert.equal(await run("notesView===null && !document.querySelector('#note-heading') && !document.body.textContent.includes('Dummy planning notes')"), true);
  console.log(`Notes UI passed: plain-text selection copy, clipboard lock cleanup, CRUD, safe text, dirty edits, pagination, navigation, resize and lock races. Synthetic screenshots: ${root}`);
  app.exit(0);
}
setTimeout(() => { console.error("Notes UI timeout"); app.exit(1); }, 120000).unref();
main().catch(error => { console.error(error); app.exit(1); });
