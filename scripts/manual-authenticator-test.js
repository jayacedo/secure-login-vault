const assert = require('assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { createSetupQr } = require('../src/services/manualAuthenticator');
const { decodeQr } = require('../src/services/authenticatorQr');
const { generateCode } = require('../src/services/totp');
const { createVaultStore } = require('../src/services/vaultStore');
const { createAuthenticator } = require('../src/services/authenticator');
const { testTempRoot } = require('./testTemp');
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // Public RFC test vector.
async function main() {
  const image = (await createSetupQr({secret:'gezd gnbv gy3t qojq\n gezd gnbv gy3t qojq'})).image;
  let config = decodeQr(image);
  assert.equal(config.secret.toString(),'12345678901234567890');
  assert.equal(config.digits,6); assert.equal(config.period,30); assert.equal(config.algorithm,'SHA1');
  assert.equal(generateCode(config,59000).code,'287082'); config.secret.fill(0);
  for(const algorithm of ['SHA1','SHA256','SHA512']) {
    config=decodeQr((await createSetupQr({secret,algorithm,digits:'8',period:'60'})).image);
    assert.equal(config.algorithm,algorithm); assert.equal(config.digits,8);assert.equal(config.period,60);config.secret.fill(0);
  }
  for(const options of [null,[],{}, {secret:123456},{secret:'123456'},{secret:'JBSWY3DP'},{secret:'A'.repeat(257)},
    {secret:'https://example.test'}, {secret:secret+'!'}, {secret:secret+'='},{secret,algorithm:'MD5'},
    {secret,digits:'7'},{secret,period:'0'},{secret,period:'121'},{secret,period:'30.5'},{secret,period:30}]) {
    await assert.rejects(createSetupQr(options),error=>error.isPublic&&!error.message.includes(secret));
  }
  const root=await fs.mkdtemp(path.join(testTempRoot(),'manual-authenticator-'));
  const vault=createVaultStore(root),pw='Synthetic manual setup vault password';
  await vault.createVault({masterPassword:pw,confirmPassword:pw});
  const id=(await vault.createCredential({websiteName:'Synthetic authenticator',password:'Dummy-only',qrCode:image})).id;
  assert.equal((await vault.getAllCredentials()).find(row=>row.id===id).hasQrCode,true);
  const saved=await vault.getCredential(id);assert.equal(saved.qrCode,image);
  const auth=createAuthenticator({vault,clipboard:{readText:async()=>'',clear:async()=>{},writeText:async()=>{}},now:()=>59000});
  assert.equal((await auth.start(()=>vault.getCredential(id).then(row=>row.qrCode))).code,'287082');await auth.clear();
  const bytes=await fs.readFile(path.join(root,'vault/vault-data.slv'));
  assert.equal(bytes.includes(Buffer.from(secret)),false);assert.equal(bytes.includes(Buffer.from(image)),false);
  const backup=path.join(root,'dummy.slvbackup');await vault.createEncryptedBackup(backup);
  assert.equal((await fs.readFile(backup)).includes(Buffer.from(secret)),false);
  vault.lockVault();await vault.restoreEncryptedBackup(backup,pw);await vault.unlockVault({masterPassword:pw});
  assert.equal((await vault.getCredential(id)).qrCode,image);vault.lockVault();
  console.log('PASS manual setup: normalization, validation, algorithms, RFC code, encrypted storage, backup/restore and existing Generate flow. Fixture: '+root);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
