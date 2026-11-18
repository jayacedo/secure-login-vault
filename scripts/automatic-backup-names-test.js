const assert = require('assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { createAutomaticBackups, DAY_MS } = require('../src/services/automaticBackups');
const { testTempRoot } = require('./testTemp');
async function main() {
  const root = await fs.mkdtemp(path.join(testTempRoot(), 'backup-names-'));
  const folder = path.join(root, 'backups'); await fs.mkdir(folder);
  const configPath = path.join(root, 'config.json');
  const id = '11111111-1111-4111-8111-111111111111';
  let time = Date.UTC(2026, 10, 19, 6, 30, 5, 123);
  const legacy = `slv-auto-${id}-${time - DAY_MS}-123456789abc.slvbackup`;
  const unrelated = 'slv-auto-2026-11-19_14-30-05.123_UTC+0800-22222222-2222-4222-8222-222222222222-123456789abc.slvbackup';
  await fs.writeFile(path.join(folder, legacy), 'synthetic legacy fixture');
  await fs.writeFile(path.join(folder, unrelated), 'synthetic other installation');
  await fs.writeFile(path.join(folder, 'manual.slvbackup'), 'synthetic manual backup');
  await fs.writeFile(configPath, JSON.stringify({version:1,id,enabled:true,folder,keep:7,lastSuccess:time-DAY_MS,files:[legacy,unrelated,'../outside.slvbackup']}));
  const vault = {getState:async()=>({isUnlocked:true}),createEncryptedBackup:async target=>fs.writeFile(target,'synthetic backup fixture',{flag:'wx'})};
  const create = () => createAutomaticBackups({configPath,vault,now:()=>time});
  let service=create(); await service.load();
  assert.deepEqual(service.status().latestBackup,{fileName:legacy,createdAt:time-DAY_MS});
  assert.equal(await service.latestForVerification(),path.join(folder,legacy));
  await service.run();
  const first=service.status().latestBackup;
  assert.equal(first.createdAt,time);
  assert.match(first.fileName,/^slv-auto-2026-11-19_\d{2}-\d{2}-05\.123_UTC[+-]\d{4}-/);
  assert.ok(first.fileName.includes(id));
  assert.equal(/[<>:"/\\|?*]/.test(first.fileName),false,'Windows-safe name');
  await fs.access(path.join(folder,legacy));
  await service.run({force:true});
  assert.notEqual(service.status().latestBackup.fileName,first.fileName,'same millisecond remains unique');
  service=create();await service.load();
  assert.equal(service.status().latestBackup.createdAt,time,'restart parses milliseconds and offset');
  assert.equal(await service.latestForVerification(),path.join(folder,service.status().latestBackup.fileName));
  // Offset in the filename is authoritative, independent of the current machine timezone.
  const offsetName=`slv-auto-2026-11-19_14-30-05.123_UTC+0800-${id}-abcdef123456.slvbackup`;
  const saved=JSON.parse(await fs.readFile(configPath,'utf8'));
  await fs.writeFile(path.join(folder,offsetName),'synthetic offset fixture');
  await fs.writeFile(configPath,JSON.stringify({...saved,files:[offsetName,...saved.files]}));
  service=create();await service.load();assert.equal(service.status().latestBackup.createdAt,time);
  for(let i=0;i<8;i++){time+=DAY_MS;await service.run();}
  const retained=JSON.parse(await fs.readFile(configPath,'utf8'));
  assert.equal(retained.files.length,7);
  await assert.rejects(fs.access(path.join(folder,legacy)),{code:'ENOENT'});
  await fs.access(path.join(folder,unrelated));await fs.access(path.join(folder,'manual.slvbackup'));
  assert.equal((await fs.readdir(folder)).length,9);
  console.log('PASS readable backup names, millisecond/offset timestamps, legacy verification, mixed retention, unique names and unrelated-file preservation. Synthetic fixture: '+root);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
