const assert = require("assert/strict");
const fs = require("fs/promises");
const path = require("path");
const { createVaultStore } = require("../src/services/vaultStore");
const { testTempRoot } = require("./testTemp");

async function main() {
  const root = await fs.mkdtemp(path.join(testTempRoot(), "bulk-category-"));
  const store = createVaultStore(root), pw = "synthetic category master password";
  try {
    await store.createVault({masterPassword:pw,confirmPassword:pw});
    await store.createCategory("Synthetic destination");
    await store.createGroup("Source"); await store.createGroup("Outside");
    const data = {websiteName:"Synthetic account",websiteUrl:"https://example.test",username:"dummy-user",password:"dummy-original",notes:"dummy-private-note",tags:"dummy,test",favorite:true,groupName:"Source",category:"Other",qrCode:await require("qrcode").toDataURL("dummy image")};
    const a = (await store.createCredential(data)).id;
    const b = (await store.createCredential({...data,websiteName:"Second dummy"})).id;
    const c = (await store.createCredential({...data,groupName:"Outside"})).id;
    await store.editCredential(a,{...data,password:"dummy-changed"});
    const before = await store.getCredential(a), history = await store.getPasswordHistory(a);
    await store.setCurrentActiveGroup("Source");
    const choice = {ids:[a,b],targetCategory:"synthetic destination"};
    const review = await store.previewCredentialCategory(choice);
    assert.equal(review.targetCategory,"Synthetic destination");
    assert.equal(review.entries[0].category,"Other");
    for (const secret of [data.password,data.notes,data.qrCode,"dummy-changed"]) assert(!JSON.stringify(review).includes(secret));
    const db = path.join(root,"vault/vault-data.slv"), initial = await fs.readFile(db);
    await assert.rejects(store.changeCredentialCategory({...choice,revision:review.revision}),/confirm/);
    for (const invalid of [{ids:[]},{ids:[a,a]},{ids:[a,c]},{ids:[a,999999]},{targetCategory:""},{targetCategory:"Missing"},{ids:Array.from({length:501},(_,i)=>i+1)}]) {
      await assert.rejects(store.previewCredentialCategory({...choice,...invalid}));
    }
    const groupReview = await store.previewCredentialMove({ids:[a,b],targetGroup:"Source"});
    await assert.rejects(store.changeCredentialCategory({...choice,revision:groupReview.revision,confirmed:true}),/changed/);
    assert.deepEqual(await fs.readFile(db),initial);
    const rename = fs.rename;
    fs.rename = async (from,to) => { if (path.resolve(to)===path.resolve(db)) throw Error("synthetic save failure"); return rename(from,to); };
    try { await assert.rejects(store.changeCredentialCategory({...choice,revision:review.revision,confirmed:true}),/synthetic save failure/); }
    finally { fs.rename = rename; }
    assert.deepEqual(await fs.readFile(db),initial,"failed save publishes no part of the batch");
    const applied = await store.changeCredentialCategory({...choice,revision:review.revision,confirmed:true});
    assert.equal(typeof applied.undoToken,"string");
    assert.deepEqual({...applied,undoToken:undefined},{changed:2,unchanged:0,targetCategory:"Synthetic destination",undoToken:undefined});
    const after = await store.getCredential(a);
    const {category:oldCategory,updatedAt:oldDate,...oldFields} = before;
    const {category:newCategory,updatedAt:newDate,...newFields} = after;
    assert.equal(newCategory,"Synthetic destination"); assert.deepEqual(newFields,oldFields);
    assert.deepEqual(await store.getPasswordHistory(a),history);
    assert.equal((await store.getActivityHistory({})).entries.filter(e=>e.event==="updated").length,2);
    const noop = await store.previewCredentialCategory(choice);
    assert.equal(noop.unchanged,2);
    assert.equal((await store.changeCredentialCategory({...choice,revision:noop.revision,confirmed:true})).changed,0);
    const back = {ids:[a,b],targetCategory:"Other"};
    const stale = await store.previewCredentialCategory(back);
    await store.editCredential(a,{...after,notes:"dummy edited after review"});
    await assert.rejects(store.changeCredentialCategory({...back,revision:stale.revision,confirmed:true}),/changed/);
    const fresh = await store.previewCredentialCategory(back);
    store.lockVault(); await assert.rejects(store.changeCredentialCategory({...back,revision:fresh.revision,confirmed:true}));
    await store.unlockVault({masterPassword:pw});
    await assert.rejects(store.changeCredentialCategory({...back,revision:fresh.revision,confirmed:true}),/changed/);
    const scope = await store.previewCredentialCategory(back);
    await store.setCurrentActiveGroup("");
    await assert.rejects(store.changeCredentialCategory({...back,revision:scope.revision,confirmed:true}),/changed/);
    assert.equal((await store.getCredential(c)).category,"Other");
    const renamed = await store.previewCredentialCategory(choice);
    await store.editCategory("Synthetic destination","Renamed synthetic");
    await assert.rejects(store.changeCredentialCategory({...choice,revision:renamed.revision,confirmed:true}),/no longer exists/);
    console.log("PASS synthetic bulk category: atomic save/failure, validation, scope/session/stale guards, operation-bound review, unchanged groups/QR/history, activity and no-op");
  } finally { store.lockVault(); await fs.rm(root,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
