const assert = require('assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { EventEmitter } = require('events');
const { testTempRoot } = require('./testTemp');
const { createDesktopIntegration, DEFAULTS } = require('../src/services/desktopIntegration');

async function main() {
 const root = await fs.mkdtemp(path.join(testTempRoot(), 'desktop-settings-'));
 const configPath = path.join(root, 'desktop-integration.json');
 const trays = [], writes = [];
 let visible=true, unlocked=true, login={openAtLogin:false,executableWillLaunchAtLogin:false}, quit=0, locks=0;
 class FakeTray extends EventEmitter {
  constructor(){super();this.destroyed=false;trays.push(this);}
  setToolTip(value){this.tooltip=value;} setContextMenu(value){this.menu=value;} destroy(){this.destroyed=true;}
 }
 const app={isPackaged:true,getLoginItemSettings(options){assert.deepEqual(options.args,['--slv-startup']);return {...login};},setLoginItemSettings(options){writes.push(options);login={openAtLogin:options.openAtLogin,executableWillLaunchAtLogin:options.enabled&&options.openAtLogin};},quit(){quit++;}};
 let service;
 const options={app,Tray:FakeTray,Menu:{buildFromTemplate:items=>items},configPath,iconPath:'dummy.ico',platform:'win32',portable:false,executable:'C:\\Program Files\\SLV\\Secure Login Vault.exe',getWindow:()=>({isVisible:()=>visible,hide:()=>{visible=false;}}),isUnlocked:()=>unlocked,openWindow:()=>{visible=true;},lockVault:()=>{locks++;unlocked=false;service.refresh();}};
 service=createDesktopIntegration(options);await service.load();
 assert.equal(service.hasTray(),false);assert.equal(writes.length,0);
 await service.configure({startWithWindows:true,startInTray:true,closeToTray:true});
 assert.equal(service.status().startWithWindows,true);assert.equal(writes[0].path,`"${options.executable}"`);
 assert.equal(service.shouldStartHidden(['--slv-startup'],true),true);
 assert.equal(service.shouldStartHidden([],true),false);
 assert.equal(service.shouldStartHidden(['--slv-startup'],false),false,'first-launch setup stays visible');
 let prevented=false;service.handleClose({preventDefault(){prevented=true;}});
 assert.equal(prevented,true);assert.equal(visible,false);assert.equal(unlocked,false);
 assert.match(trays[0].tooltip,/Locked/);trays[0].emit('click');assert.equal(visible,true);
 assert.equal(trays[0].menu[1].enabled,false);
 unlocked=true;service.refresh();trays[0].menu[1].click();assert.equal(unlocked,false);assert.ok(locks>=2);
 const count=writes.length;
 login.executableWillLaunchAtLogin=false;
 const reloaded=createDesktopIntegration(options);await reloaded.load();
 assert.equal(reloaded.status().startWithWindows,false,'respect Windows Startup Apps override');assert.equal(writes.length,count,'launch must not reenroll startup');reloaded.dispose();
 await service.configure({startWithWindows:false,startInTray:false,closeToTray:true});
 assert.equal(login.openAtLogin,false);
 visible=false;await service.configure({...DEFAULTS});assert.equal(visible,true,'turning off tray reveals hidden window');assert.equal(service.hasTray(),false);
 await service.configure({startWithWindows:false,startInTray:true,closeToTray:false});
 unlocked=true;prevented=false;service.handleClose({preventDefault(){prevented=true;}});assert.equal(prevented,false,'normal dashboard close still quits');
 unlocked=false;service.handleClose({preventDefault(){prevented=true;}});assert.equal(prevented,true,'compact unlock X returns to tray');
 const active=trays.at(-1);active.menu[3].click();assert.equal(quit,1);prevented=false;service.handleClose({preventDefault(){prevented=true;}});assert.equal(prevented,false,'Quit bypasses close-to-tray');service.dispose();assert.equal(active.destroyed,true);
 const failing=createDesktopIntegration({...options,write:async()=>{throw Error('disk full');}});await failing.load();
 await assert.rejects(failing.configure({startWithWindows:true,startInTray:true,closeToTray:true}), /Could not save startup and tray preferences/);
 assert.equal(login.openAtLogin,false,'failed preference write rolls back startup');failing.dispose();
 for(const extra of [{portable:true},{app:{...app,isPackaged:false}},{platform:'linux'}]) {
  const unsupported=createDesktopIntegration({...options,...extra});await unsupported.load();
  assert.equal(unsupported.status().startupSupported,false);
  await assert.rejects(unsupported.configure({startWithWindows:true,startInTray:true,closeToTray:true}));unsupported.dispose();
 }
 const noTray=createDesktopIntegration({...options,Tray:class {constructor(){throw Error('unavailable');}}});await noTray.load();
 assert.equal(noTray.shouldStartHidden(['--slv-startup'],true),false);assert.equal(noTray.hideLocked(),false);noTray.dispose();
 console.log('PASS startup opt-in/removal, Windows override, rollback, tray actions, first launch, close/quit, unsupported installs and missing tray fallback.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
