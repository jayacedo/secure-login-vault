const assert = require("assert/strict");
const fs = require("fs/promises");
const path = require("path");
const { createVaultStore } = require("../src/services/vaultStore");
const { testTempRoot } = require("./testTemp");

async function main() {
  const root = await fs.mkdtemp(path.join(testTempRoot(), "bulk-move-"));
  const store = createVaultStore(root);
  const pw = "synthetic bulk move master password";
  try {
    await store.createVault({ masterPassword: pw, confirmPassword: pw });
    await store.createGroup("Source"); await store.createGroup("Destination"); await store.createGroup("Other");
    const qrCode = await require("qrcode").toDataURL("synthetic image preservation test");
    const data = { websiteName: "Synthetic login", websiteUrl: "https://example.test/login", username: "dummy", password: "dummy-original", email: "dummy@example.test", notes: "synthetic notes", tags: "dummy,bulk", favorite: true, category: "Other", groupName: "Source", qrCode };
    const a = (await store.createCredential(data)).id;
    const b = (await store.createCredential({ ...data, websiteName: "Second synthetic", favorite: false })).id;
    const outside = (await store.createCredential({ ...data, groupName: "Other" })).id;
    await store.editCredential(a, { ...data, password: "dummy-new" });
    const beforeA = await store.getCredential(a), beforeB = await store.getCredential(b);
    const historyBefore = await store.getPasswordHistory(a);
    await store.setCurrentActiveGroup("Source");
    const choice = { ids: [b, a], targetGroup: "destination" };
    const review = await store.previewCredentialMove(choice);
    assert.equal(review.targetGroup, "Destination");
    assert.equal(review.entries.length, 2);
    for (const secret of ["dummy-new", "dummy-original", "synthetic notes"]) assert(!JSON.stringify(review).includes(secret));
    const dbPath = path.join(root, "vault/vault-data.slv");
    const beforeFailure = await fs.readFile(dbPath);
    await assert.rejects(store.moveCredentialsToGroup({ ...choice, revision: review.revision }), /confirm/i);
    await assert.rejects(store.previewCredentialMove({ ids: [a, a], targetGroup: "Destination" }), /Select/);
    await assert.rejects(store.previewCredentialMove({ ids: [a, outside], targetGroup: "Destination" }), /active group/);
    await assert.rejects(store.previewCredentialMove({ ids: [a, 999999], targetGroup: "Destination" }), /unavailable/);
    await assert.rejects(store.previewCredentialMove({ ids: Array.from({length:501},(_,i)=>i+1), targetGroup: "Destination" }), /500/);
    assert.deepEqual(await fs.readFile(dbPath), beforeFailure, "invalid batch requests do not publish any writes");
    const originalRename = fs.rename;
    fs.rename = async (from, to) => {
      if (path.resolve(to) === path.resolve(dbPath)) throw Error("synthetic commit failure");
      return originalRename(from, to);
    };
    try {
      await assert.rejects(store.moveCredentialsToGroup({...choice, revision:review.revision, confirmed:true}), /synthetic commit failure/);
    } finally { fs.rename = originalRename; }
    assert.deepEqual(await fs.readFile(dbPath), beforeFailure, "failed final save publishes neither move nor activity events");
    const result = await store.moveCredentialsToGroup({ ...choice, revision: review.revision, confirmed: true });
    assert.equal(typeof result.undoToken, "string");
    assert.deepEqual({...result,undoToken:undefined}, { moved: 2, unchanged: 0, targetGroup: "Destination",undoToken:undefined });
    assert.equal((await store.getAllCredentials()).length, 0, "moved logins leave the active group view");
    await store.setCurrentActiveGroup("");
    for (const [id, before] of [[a, beforeA], [b, beforeB]]) {
      const after = await store.getCredential(id);
      assert.equal(after.groupName, "Destination");
      const { groupName: oldGroup, updatedAt: oldDate, ...oldFields } = before;
      const { groupName: newGroup, updatedAt: newDate, ...newFields } = after;
      assert.deepEqual(newFields, oldFields, "move preserves all other credential fields");
    }
    assert.deepEqual(await store.getPasswordHistory(a), historyBefore);
    const events = (await store.getActivityHistory({})).entries.filter(event => event.groupName === "Destination" && event.event === "updated");
    assert.equal(events.length, 2, "one existing Updated activity event per changed credential");
    assert.equal((await store.getCredential(outside)).groupName, "Other");
    const noop = await store.previewCredentialMove({ ids:[a,b],targetGroup:"Destination" });
    assert.equal(noop.unchanged, 2);
    assert.equal((await store.moveCredentialsToGroup({ids:[a,b],targetGroup:"Destination",revision:noop.revision,confirmed:true})).moved, 0);
    const staleChoice = { ids: [a,b], targetGroup: "Source" };
    const stale = await store.previewCredentialMove(staleChoice);
    await store.editCredential(a, { ...(await store.getCredential(a)), notes: "changed since review" });
    const afterEdit = await fs.readFile(dbPath);
    await assert.rejects(store.moveCredentialsToGroup({...staleChoice,revision:stale.revision,confirmed:true}), /changed/);
    assert.deepEqual(await fs.readFile(dbPath), afterEdit, "stale review moves neither entry");
    const fresh = await store.previewCredentialMove(staleChoice);
    store.lockVault();
    await assert.rejects(store.moveCredentialsToGroup({...staleChoice,revision:fresh.revision,confirmed:true}));
    await store.unlockVault({masterPassword:pw});
    await assert.rejects(store.moveCredentialsToGroup({...staleChoice,revision:fresh.revision,confirmed:true}), /changed/);
    const scopeReview = await store.previewCredentialMove(staleChoice);
    await store.setCurrentActiveGroup("Destination");
    await assert.rejects(store.moveCredentialsToGroup({...staleChoice,revision:scopeReview.revision,confirmed:true}), /changed/);
    const deletedGroupReview = await store.previewCredentialMove(staleChoice);
    await store.editGroup("Source", "Renamed source");
    await assert.rejects(store.moveCredentialsToGroup({...staleChoice,revision:deletedGroupReview.revision,confirmed:true}), /no longer exists/);
    const ungrouped = await store.previewCredentialMove({ids:[a,b],targetGroup:""});
    await store.moveCredentialsToGroup({ids:[a,b],targetGroup:"",revision:ungrouped.revision,confirmed:true});
    await store.setCurrentActiveGroup("");
    assert.equal((await store.getCredential(a)).groupName, "");
    console.log("PASS synthetic bulk move: reviewed atomic batches, scope/session/stale guards, unchanged fields/history, activity, no-op and ungrouped destination");
  } finally { store.lockVault(); await fs.rm(root, {recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
