// Local presentation preference only. The guide never reads login contents,
// writes vault records, registers a browser or enables backups.
const GETTING_STARTED_KEY = 'slv_getting_started_v1';
let gettingStartedGuide = null;
let gettingStartedLocked = true;

function gettingStartedPending() { return getPref(GETTING_STARTED_KEY, 'off') === 'pending'; }
function queueGettingStartedForNewVault() {
  if (getPref(GETTING_STARTED_KEY, '') === '') setPref(GETTING_STARTED_KEY, 'pending');
}
function gettingStartedAuthState(state) {
  gettingStartedLocked = !state.isUnlocked;
  if (gettingStartedLocked) stopGettingStartedGuide(false);
}
function maybeStartGettingStartedGuide() {
  if (!gettingStartedLocked && gettingStartedPending() && !gettingStartedGuide &&
      !document.body.classList.contains('unlock-presenting') &&
      document.querySelector('#credential-search') && !document.querySelector('.modal-overlay.is-open')) {
    startGettingStartedGuide();
  }
}

function renderGettingStartedSettings() {
  return `<section class="settings-section">
    <h3 class="settings-section-title">Getting started</h3>
    <label class="settings-row desktop-preference-row" for="getting-started-enabled">
      <span class="settings-row-label"><span class="settings-row-name">Show getting-started guide</span>
      <span class="settings-row-hint">A short tour of logins, browser setup and backups. Finishing or skipping turns it off on this device.</span></span>
      <input type="checkbox" id="getting-started-enabled" ${gettingStartedPending() ? 'checked' : ''} />
    </label>
    <button type="button" class="secondary-button" id="getting-started-restart">Restart guide</button>
    <p class="settings-row-hint">Turning this on starts the tour. You can also restart it from Help.</p>
  </section>`;
}
function setupGettingStartedSettings(overlay) {
  overlay.querySelector('#getting-started-enabled').addEventListener('change', event => {
    setPref(GETTING_STARTED_KEY, event.target.checked ? 'pending' : 'off');
    if (event.target.checked) startGettingStartedGuide(true);
    else stopGettingStartedGuide();
  });
  overlay.querySelector('#getting-started-restart').addEventListener('click', () => startGettingStartedGuide(true));
}

function stopGettingStartedGuide(restoreFocus = true) {
  const guide = gettingStartedGuide;
  gettingStartedGuide = null;
  if (!guide) return;
  cancelAnimationFrame(guide.frame);
  guide.observer?.disconnect();
  window.removeEventListener('resize', guide.schedule);
  document.removeEventListener('scroll', guide.schedule, true);
  document.removeEventListener('keydown', guide.keydown, true);
  guide.overlay.remove();
  for (const [element, inert] of guide.inert) element.inert = inert;
  if (guide.ownsSettings) closeSettingsModal();
  activeSettingsSection = guide.previousSection;
  if (restoreFocus && !gettingStartedLocked) {
    const target = guide.returnFocus?.isConnected && guide.returnFocus.getClientRects().length ? guide.returnFocus : document.querySelector('#open-help-btn');
    target?.focus({ preventScroll: true });
  }
}
function lockGettingStartedGuide() {
  gettingStartedLocked = true;
  stopGettingStartedGuide(false);
}

async function startGettingStartedGuide(explicit = false) {
  if (gettingStartedLocked || !document.body.classList.contains('is-dashboard') || gettingStartedGuide) return;
  const openModals = [...document.querySelectorAll('.modal-overlay.is-open')];
  if (openModals.some(modal => !['settings-modal-overlay', 'help-modal-overlay'].includes(modal.id))) return;
  const returnFocus = document.activeElement;
  closeHelpModal(); closeSettingsModal();
  if (explicit) setPref(GETTING_STARTED_KEY, 'pending');
  if (!document.querySelector('#credential-search')) renderDashboard(_lastAuthState);
  const overlay = document.createElement('div');
  overlay.id = 'getting-started-overlay';
  overlay.innerHTML = `<div class="getting-started-spotlight" aria-hidden="true" hidden></div>
    <div class="getting-started-arrow" aria-hidden="true" hidden></div>
    <section class="getting-started-balloon" role="dialog" aria-modal="true" aria-labelledby="getting-started-title" aria-describedby="getting-started-copy">
      <div class="getting-started-step"><span id="getting-started-progress"></span><span class="getting-started-dots" aria-hidden="true">${'<span></span>'.repeat(5)}</span></div>
      <h2 id="getting-started-title"></h2><p id="getting-started-copy"></p>
      <div class="getting-started-footer"><button type="button" class="link-button" id="getting-started-skip">Skip tour</button>
        <div><button type="button" class="secondary-button" id="getting-started-back">Back</button><button type="button" class="primary-button" id="getting-started-next">Next</button></div></div>
    </section>`;
  const guide = { overlay, index:0, frame:0, target:null, inert:new Map(), returnFocus, previousSection:activeSettingsSection, ownsSettings:false, busy:false };
  gettingStartedGuide = guide;
  const balloon = overlay.querySelector('.getting-started-balloon');
  const ring = overlay.querySelector('.getting-started-spotlight');
  const arrow = overlay.querySelector('.getting-started-arrow');
  const next = overlay.querySelector('#getting-started-next');
  const back = overlay.querySelector('#getting-started-back');
  const skip = overlay.querySelector('#getting-started-skip');
  const valid = () => gettingStartedGuide === guide && !gettingStartedLocked;
  function makeInert(element) {
    if (element && !guide.inert.has(element)) { guide.inert.set(element, element.inert); element.inert = true; }
  }
  makeInert(appShell);
  document.body.append(overlay);
  function place() {
    guide.frame = 0;
    if (!valid()) return;
    const width = window.innerWidth, height = window.innerHeight, margin = 16;
    const box = balloon.getBoundingClientRect();
    const target = guide.target?.isConnected && guide.target.getClientRects().length ? guide.target.getBoundingClientRect() : null;
    const visibleTarget = target && target.width > 0 && target.height > 0 && target.top >= 0 && target.bottom <= height && target.left >= 0 && target.right <= width;
    ring.hidden = !visibleTarget;
    overlay.classList.toggle('has-spotlight', Boolean(visibleTarget));
    arrow.hidden = true;
    let x = (width - box.width) / 2, y = (height - box.height) / 2;
    if (visibleTarget) {
      Object.assign(ring.style, { left: `${target.left - 5}px`, top: `${target.top - 5}px`, width: `${target.width + 10}px`, height: `${target.height + 10}px` });
      x = Math.max(margin, Math.min(width - box.width - margin, target.right - box.width));
      let arrowY;
      if (target.bottom + 20 + box.height <= height - margin) { y = target.bottom + 20; arrowY=y-6; arrow.classList.remove('points-down'); }
      else if (target.top - 20 - box.height >= margin) { y = target.top - box.height - 20; arrowY=y+box.height-6; arrow.classList.add('points-down'); }
      if (arrowY !== undefined) {
        arrow.hidden=false;
        Object.assign(arrow.style, {left:`${x + Math.max(24, Math.min(box.width-24, target.left+target.width/2-x)) - 6}px`,top:`${arrowY}px`});
      }
    }
    Object.assign(balloon.style, { left: `${Math.max(margin, x)}px`, top: `${Math.max(margin, Math.min(height - box.height - margin, y))}px` });
  }
  guide.schedule = () => { if (!guide.frame && valid()) guide.frame = requestAnimationFrame(place); };
  guide.observer = new ResizeObserver(guide.schedule);
  guide.observer.observe(balloon); guide.observer.observe(appShell);
  window.addEventListener('resize', guide.schedule);
  document.addEventListener('scroll', guide.schedule, {capture:true,passive:true});
  guide.keydown = event => {
    if (!valid()) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
      event.preventDefault(); event.stopImmediatePropagation(); handleLockVault(); return;
    }
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); skip.click(); return; }
    if (event.key === 'Tab') {
      const controls = [skip, back, next].filter(button => !button.disabled);
      const index = controls.indexOf(document.activeElement);
      if (index < 0 || (!event.shiftKey && index === controls.length - 1) || (event.shiftKey && index === 0)) {
        event.preventDefault(); controls[event.shiftKey ? controls.length-1 : 0].focus();
      }
      event.stopImmediatePropagation();
    } else if (event.ctrlKey || event.metaKey) { event.stopImmediatePropagation(); }
  };
  document.addEventListener('keydown', guide.keydown, true);
  const steps = [
    ['Your vault is ready.', 'This short tour shows where to add a login, connect a browser and set up backups. Next only moves through the guide.'],
    ['Add your first login', 'Use + to save a website, username and password. You can also import existing logins from Settings → Backup & Data.'],
    ['Connect your browser', 'Set Up Browser Extension registers the helper and opens the extension folder. Follow the browser instructions, then use Add browser to pair. Nothing is installed or paired by this tour.'],
    ['Give your vault a backup', 'Choose a backup folder, then turn on Automatic Backups. Keep a copy on another drive when possible. This tour leaves backups unchanged.'],
    ['You’re ready to explore', 'Open Help anytime to review setup steps or restart this guide. Turn it on or off in Settings → General. Finish tour stops it appearing automatically.']
  ];
  async function showStep(index) {
    if (!valid() || guide.busy) return;
    guide.busy = true; next.disabled = back.disabled = true; guide.target = null;
    try {
      guide.index = index;
      overlay.querySelector('#getting-started-title').textContent = steps[index][0];
      overlay.querySelector('#getting-started-copy').textContent = steps[index][1];
      overlay.querySelector('#getting-started-progress').textContent = `GETTING STARTED · ${index + 1} OF 5`;
      overlay.querySelectorAll('.getting-started-dots span').forEach((dot,i) => dot.classList.toggle('is-current', i === index));
      next.textContent = index === 4 ? 'Finish tour' : 'Next';
      if (index === 2 || index === 3) {
        if (!guide.ownsSettings) {
          guide.ownsSettings = true;
          await openSettingsModal({ isCancelled: () => !valid() });
          if (!valid()) return;
          makeInert(document.querySelector('#settings-modal-overlay'));
        }
        // Only navigation clicks; never invoke setup, pairing, file pickers or writes.
        document.querySelector(`[data-settings-tab="${index === 2 ? 'browsers' : 'data'}"]`)?.click();
        if (index === 2) document.querySelector('#extension-installation').open = true;
        guide.target = document.querySelector(index === 2 ? '#extension-setup-btn' : '#auto-backup-choose');
      } else {
        if (guide.ownsSettings) { closeSettingsModal(); guide.ownsSettings = false; }
        guide.target = document.querySelector(index === 1 ? '#add-credential-btn' : index === 4 ? '#open-help-btn' : '#no-guide-target');
      }
      guide.target?.scrollIntoView({ block:'center', inline:'nearest', behavior:'instant' });
    } catch {
      if (valid()) { setPref(GETTING_STARTED_KEY, 'off'); stopGettingStartedGuide(); showToast('The guide could not open. Restart it from Help.', 'error'); }
    } finally {
      if (valid()) { guide.busy=false; next.disabled=false; back.disabled=index===0; guide.schedule(); next.focus({preventScroll:true}); }
    }
  }
  skip.onclick = () => { setPref(GETTING_STARTED_KEY, 'off'); stopGettingStartedGuide(); };
  next.onclick = () => {
    if (guide.index === 4) { setPref(GETTING_STARTED_KEY, 'done'); stopGettingStartedGuide(); }
    else showStep(guide.index + 1);
  };
  back.onclick = () => showStep(Math.max(0, guide.index - 1));
  await showStep(0);
}
