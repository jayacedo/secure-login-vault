async function initializeSavePrompt() {
  const api = window.saveLoginPrompt;
  if (!api) return;
  const cancel = document.querySelector("#save-cancel");
  const save = document.querySelector("#save-confirm");
  cancel.onclick = () => api.respond({ approved: false });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") api.respond({ approved: false });
  });
  try {
    const data = await api.load();
    if (!data) return;
    document.documentElement.dataset.theme = data.dark ? "dark" : "light";
    document.querySelector("#save-host").textContent = data.host;
    document.querySelector("#save-username").textContent = data.username;
    const group = document.querySelector("#save-group");
    const category = document.querySelector("#save-category");
    group.replaceChildren(new Option("Unassigned", ""), ...data.groups.map(name => new Option(name, name)));
    category.replaceChildren(...data.categories.map(name => new Option(name, name)));
    group.value = data.activeGroup;
    category.value = data.categories.includes("Other") ? "Other" : data.categories[0];
    const updateHint = () => {
      document.querySelector("#save-group-note").textContent = data.activeGroup && group.value !== data.activeGroup
        ? "This login will be outside your active group. Switch groups to see it in the vault."
        : "You can change the group and category later in the vault.";
    };
    group.onchange = updateHint;
    updateHint();
    group.disabled = category.disabled = save.disabled = false;
    save.onclick = () => {
      save.disabled = true;
      api.respond({ approved: true, groupName: group.value, category: category.value });
    };
    cancel.focus();
  } catch { api.respond({ approved: false }); }
}
initializeSavePrompt();
