// Node mode only: do not launch the installed app or load any user profile.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
async function main() {
  if (process.argv.includes('--synthetic-child')) {
    const archive = path.resolve(__dirname,'../release/win-unpacked/resources/app.asar');
    const {createSetupQr}=require(path.join(archive,'src/services/manualAuthenticator.js'));
    const {decodeQr}=require(path.join(archive,'src/services/authenticatorQr.js'));
    const {generateCode}=require(path.join(archive,'src/services/totp.js'));
    const {decodeInWorker,createAuthenticator}=require(path.join(archive,'src/services/authenticator.js'));
    const {PNG}=require(path.join(archive,'node_modules/pngjs'));
    const image=(await createSetupQr({secret:'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'})).image;
    const config=decodeQr(image);
    assert.equal(generateCode(config,59000).code,'287082');config.secret.fill(0);
    const png=PNG.sync.read(Buffer.from(image.split(',')[1],'base64'));
    for(let i=0;i<png.data.length;i+=4)png.data[i]=png.data[i+1]=png.data[i+2]=png.data[i]<128?120:128;
    const faint=await decodeInWorker('data:image/png;base64,'+PNG.sync.write(png).toString('base64'),new AbortController().signal);
    assert.equal(generateCode(faint,59000).code,'287082');faint.secret.fill(0);png.data.fill(0);
    const QR=require(path.join(archive,'node_modules/qrcode'));
    const extra=await QR.toDataURL('otpauth://totp/Synthetic?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&vendor_option=dummy',{width:420});
    const manager=createAuthenticator({vault:{isUnlocked:()=>true,getOperationEpoch:()=>1},clipboard:{readText:async()=>'',clear:async()=>{},writeText:async()=>{throw Error('Copy not expected');}},now:()=>59000});
    const pending=await manager.start(extra);
    assert.equal(pending.requiresStandardConfirmation,true);assert.equal('code' in pending,false);
    await assert.rejects(manager.copy(pending.token),/Try standard TOTP/);
    assert.equal(manager.confirmStandard(pending.token).code,'287082');await manager.clear();
    console.log('PASS packaged authenticator runtime: local QR generation, faint-image retries, explicit standard-TOTP confirmation and RFC code using shipped dependencies.');
    return;
  }
  const root=fs.mkdtempSync(path.join(require('./testTemp').testTempRoot(),'manual-authenticator-package-'));
  const result=require('child_process').spawnSync(path.resolve(__dirname,'../release/win-unpacked/Secure Login Vault.exe'),[__filename,'--synthetic-child'],{
    windowsHide:true,encoding:'utf8',timeout:30000,
    env:{...process.env,ELECTRON_RUN_AS_NODE:'1',APPDATA:root,LOCALAPPDATA:root,TEMP:root,TMP:root,SLV_PIPE_USER:'manual-package-'+process.pid}
  });
  if(result.error)throw result.error;
  assert.equal(result.status,0,result.stderr||result.stdout);
  console.log(result.stdout.trim());console.log('Synthetic runtime directory: '+root);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
