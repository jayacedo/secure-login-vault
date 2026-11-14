const assert = require("assert/strict");
const fs = require("fs/promises");
const path = require("path");
const {createVaultStore} = require("../src/services/vaultStore");
const {testTempRoot} = require("./testTemp");

async function main() {
  const root = await fs.mkdtemp(path.join(testTempRoot(),"bulk-undo-"));
  const store = createVaultStore(root), password = "Synthetic undo master password";
  try {
    await store.createVault({masterPassword:password,confirmPassword:password});
    for (const group of ["First","Second","Target"]) await store.createGroup(group);
    await store.createCategory("Synthetic category");
    const data = {websiteName:"Synthetic undo entry",websiteUrl:"https://example.test",username:"dummy",password:"dummy password",notes:"private dummy note",tags:"dummy",favorite:true,category:"Other",groupName:"First",qrCode:await require("qrcode").toDataURL("synthetic QR")};
    const a = (await store.createCredential(data)).id;
    const b = (await store.createCredential({...data,groupName:"Second",category:"Synthetic category"})).id;
    const c = (await store.createCredential({...data,groupName:"Target"})).id;
    await store.editCredential(a,{...data,password:"changed dummy password"});
    const before = await store.getCredential(a), history = await store.getPasswordHistory(a);
    const group = async (ids,targetGroup) => {
      const choice = {ids,targetGroup}; const review = await store.previewCredentialMove(choice);
      return store.moveCredentialsToGroup({...choice,revision:review.revision,confirmed:true});
    };
    const category = async (ids,targetCategory) => {
      const choice = {ids,targetCategory}; const review = await store.previewCredentialCategory(choice);
      return store.changeCredentialCategory({...choice,revision:review.revision,confirmed:true});
    };
    const db = path.join(root,"vault/vault-data.slv");
    const moved = await group([a,b,c],"Target");
    assert.equal(moved.moved,2); assert.equal(moved.unchanged,1);
    // No-op entries are not part of Undo; edits to them must be preserved.
    await store.editCredential(c,{...(await store.getCredential(c)),notes:"unrelated later change"});
    const bytes = await fs.readFile(db);
    await assert.rejects(store.undoBulkChange("forged token"),/no longer available/);
    assert.deepEqual(await fs.readFile(db),bytes);
    const rename = fs.rename;
    fs.rename = async (from,to) => { if(path.resolve(to)===path.resolve(db)) throw Error("synthetic undo save failure"); return rename(from,to); };
    try { await assert.rejects(store.undoBulkChange(moved.undoToken),/synthetic undo save failure/); }
    finally { fs.rename = rename; }
    assert.deepEqual(await fs.readFile(db),bytes,"failed undo cannot publish a partial restore");
    // Filtering to the destination must not prevent undoing the explicitly applied batch.
    await store.setCurrentActiveGroup("Target");
    assert.deepEqual(await store.undoBulkChange(moved.undoToken),{restored:2,kind:"group"});
    await assert.rejects(store.undoBulkChange(moved.undoToken),/no longer available/);
    await store.setCurrentActiveGroup("");
    assert.equal((await store.getCredential(b)).groupName,"Second");
    assert.equal((await store.getCredential(c)).notes,"unrelated later change");
    const {updatedAt:oldDate,...oldFields}=before;
    const {updatedAt:newDate,...newFields}=await store.getCredential(a);
    assert.deepEqual(newFields,oldFields); assert.deepEqual(await store.getPasswordHistory(a),history);
    const categorized = await category([a,b],"API");
    await store.undoBulkChange(categorized.undoToken);
    assert.equal((await store.getCredential(a)).category,"Other");
    assert.equal((await store.getCredential(b)).category,"Synthetic category");
    assert.equal((await store.getCredential(a)).groupName,"First");
    const events = (await store.getActivityHistory({})).entries;
    assert(events.filter(e=>e.event==="updated" && e.credentialId===a).length>=4,"undo records normal Updated activity");
    const replaced = await group([a],"Target");
    const latest = await category([b],"API");
    await assert.rejects(store.undoBulkChange(replaced.undoToken),/no longer available/);
    await store.undoBulkChange(latest.undoToken);
    const stale = await group([a,b],"First");
    const current = await store.getCredential(b);
    await store.editCredential(b,{...current,notes:"temporary later edit"});
    await store.editCredential(b,current);
    const afterEdit = await fs.readFile(db);
    await assert.rejects(store.undoBulkChange(stale.undoToken),/changed or were deleted/);
    assert.deepEqual(await fs.readFile(db),afterEdit,"one stale entry blocks the whole undo");
    const removed = await group([a,b],"Target");
    await store.removeCredential(b);
    await assert.rejects(store.undoBulkChange(removed.undoToken),/changed or were deleted/);
    const oldGroup = await group([a],"Second");
    await store.editGroup("Target","Renamed target");
    await assert.rejects(store.undoBulkChange(oldGroup.undoToken),/original group or category changed/);
    const session = await category([a],"API");
    store.lockVault(); await assert.rejects(store.undoBulkChange(session.undoToken));
    await store.unlockVault({masterPassword:password});
    await assert.rejects(store.undoBulkChange(session.undoToken),/no longer available/);
    const prior = await group([a],"");
    const noop = await group([a],"");
    assert.equal(noop.undoToken,null);
    await assert.rejects(store.undoBulkChange(prior.undoToken),/no longer available/);
    console.log("PASS synthetic Undo: mixed original assignments, preserved secrets/QR/history, activity, no-op exclusion, atomic failure/retry, replay/stale/deletion/catalog guards, latest-only and lock expiry");
  } finally { store.lockVault(); await fs.rm(root,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
