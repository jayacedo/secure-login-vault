const assert = require("assert/strict"), fs = require("fs/promises"), path = require("path");
const {createVaultStore} = require("../src/services/vaultStore");
const {testTempRoot} = require("./testTemp");
async function main() {
  const root = await fs.mkdtemp(path.join(testTempRoot(), "bulk-favorites-"));
  const store = createVaultStore(root), password = "Synthetic favorites master password";
  try {
    await store.createVault({masterPassword:password,confirmPassword:password});
    await store.createGroup("Source"); await store.createGroup("Outside");
    const data = {websiteName:"Synthetic favorite",websiteUrl:"https://example.test",username:"dummy",password:"dummy password",notes:"private dummy note",tags:"dummy",category:"Other",groupName:"Source",qrCode:await require("qrcode").toDataURL("synthetic QR")};
    const a=(await store.createCredential(data)).id, b=(await store.createCredential({...data,favorite:true})).id;
    const outside=(await store.createCredential({...data,groupName:"Outside"})).id;
    await store.editCredential(a,{...data,password:"dummy changed"});
    const before=await store.getCredential(a), history=await store.getPasswordHistory(a);
    await store.setCurrentActiveGroup("Source");
    const choice={ids:[a,b],favorite:true}, review=await store.previewCredentialFavorites(choice);
    assert.equal(review.unchanged,1);
    for (const secret of [data.password,data.notes,data.qrCode,"dummy changed"]) assert(!JSON.stringify(review).includes(secret));
    const db=path.join(root,"vault/vault-data.slv"), initial=await fs.readFile(db);
    for (const invalid of [{ids:[]},{ids:[a,a]},{ids:[a,outside]},{ids:[a,999999]},{ids:["1"]},{ids:Array.from({length:501},(_,i)=>i+1)},{favorite:1},{favorite:"true"},{favorite:null}]) await assert.rejects(store.previewCredentialFavorites({...choice,...invalid}));
    await assert.rejects(store.changeCredentialFavorites({...choice,revision:review.revision}),/confirm/);
    await assert.rejects(store.changeCredentialFavorites({...choice,favorite:false,revision:review.revision,confirmed:true}),/changed/);
    const otherReview=await store.previewCredentialCategory({ids:[a,b],targetCategory:"Other"});
    await assert.rejects(store.changeCredentialFavorites({...choice,revision:otherReview.revision,confirmed:true}),/changed/);
    assert.deepEqual(await fs.readFile(db),initial);
    const rename=fs.rename;
    fs.rename=async(from,to)=>{if(path.resolve(to)===path.resolve(db)) throw Error("synthetic save failure");return rename(from,to);};
    try {await assert.rejects(store.changeCredentialFavorites({...choice,revision:review.revision,confirmed:true}),/synthetic save failure/);} finally {fs.rename=rename;}
    assert.deepEqual(await fs.readFile(db),initial,"failed batch leaves the synthetic file unchanged");
    const apply=async(ids,favorite)=>{const choice={ids,favorite}, review=await store.previewCredentialFavorites(choice);return store.changeCredentialFavorites({...choice,revision:review.revision,confirmed:true});};
    const added=await apply([a,b],true); assert.equal(added.changed,1);assert.equal(added.unchanged,1);
    const {favorite:oldFlag,updatedAt:oldTime,...original}=before;
    const {favorite:newFlag,updatedAt:newTime,...after}=await store.getCredential(a);
    assert.equal(newFlag,true);assert.deepEqual(after,original);assert.deepEqual(await store.getPasswordHistory(a),history);
    assert.deepEqual(await store.undoBulkChange(added.undoToken),{restored:1,kind:"favorite"});
    assert.equal((await store.getCredential(a)).favorite,false);assert.equal((await store.getCredential(b)).favorite,true);
    const removed=await apply([a,b],false);assert.equal(removed.changed,1);
    await store.undoBulkChange(removed.undoToken);await assert.rejects(store.undoBulkChange(removed.undoToken),/no longer available/);
    const old=await apply([a,b],true), noop=await apply([a,b],true);assert.equal(noop.undoToken,null);await assert.rejects(store.undoBulkChange(old.undoToken));
    const stale=await store.previewCredentialFavorites({ids:[a,b],favorite:false});
    await store.editCredential(a,{...(await store.getCredential(a)),notes:"dummy later edit"});
    await assert.rejects(store.changeCredentialFavorites({ids:[a,b],favorite:false,revision:stale.revision,confirmed:true}),/changed/);
    const undoStale=await apply([a,b],false);await store.editCredential(a,{...(await store.getCredential(a)),notes:"dummy after bulk"});
    const editedBytes=await fs.readFile(db);await assert.rejects(store.undoBulkChange(undoStale.undoToken),/changed or were deleted/);assert.deepEqual(await fs.readFile(db),editedBytes);
    const scoped=await store.previewCredentialFavorites(choice);await store.setCurrentActiveGroup("");await assert.rejects(store.changeCredentialFavorites({...choice,revision:scoped.revision,confirmed:true}),/changed/);
    const token=await apply([a,b],true), sessionReview=await store.previewCredentialFavorites({ids:[a,b],favorite:false});
    store.lockVault();await assert.rejects(store.previewCredentialFavorites(choice));await assert.rejects(store.undoBulkChange(token.undoToken));await store.unlockVault({masterPassword:password});
    await assert.rejects(store.changeCredentialFavorites({ids:[a,b],favorite:false,revision:sessionReview.revision,confirmed:true}),/changed/);
    await assert.rejects(store.undoBulkChange(token.undoToken),/no longer available/);
    assert((await store.getActivityHistory({})).entries.some(e=>e.event==="updated" && e.credentialId===b));
    console.log("PASS synthetic bulk Favorites: add/remove/mixed/no-op, metadata-only review, strict validation, scope/session/stale guards, atomic failure, preserved fields/history, Undo and activity");
  } finally {store.lockVault();await fs.rm(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
