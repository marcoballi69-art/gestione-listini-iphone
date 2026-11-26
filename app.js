"use strict";

const DB_NAME = "gestione-listini-offline";
const DB_VERSION = 3;
let db, articles = [], currentItems = [], currentChoiceId = null;
let scanner = null, lastScan = "", pdfPreviewRows = [], activeListino = null, idleTimer = null, lastUnknownCode = "", preparedPdfFile = null;
let currentLanguage = "it";
let currentBusinessCardPhoto = "";
let bluetoothScannerEnabled = false;
let recentScans = [], scanBusy = false, lastScanAt = 0, audioContext = null;
let screenWakeLock = null;
const $ = id => document.getElementById(id);

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const d = request.result;
      if (!d.objectStoreNames.contains("articles")) d.createObjectStore("articles", { keyPath: "code" });
      if (!d.objectStoreNames.contains("choices")) d.createObjectStore("choices", { keyPath: "id" });
      if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta", { keyPath: "key" });
      if (!d.objectStoreNames.contains("productArchive")) d.createObjectStore("productArchive", { keyPath: "code" });
      if (!d.objectStoreNames.contains("priceLists")) d.createObjectStore("priceLists", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function store(name, mode = "readonly") { return db.transaction(name, mode).objectStore(name); }
function all(name) {
  return new Promise((resolve, reject) => {
    const r = store(name).getAll(); r.onsuccess = () => resolve(r.result || []); r.onerror = () => reject(r.error);
  });
}
function getValue(name, key) {
  return new Promise((resolve, reject) => {
    const r = store(name).get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
function put(name, value) {
  return new Promise((resolve, reject) => {
    const r = store(name, "readwrite").put(value); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
function removeRecord(name, key) {
  return new Promise((resolve, reject) => {
    const r = store(name, "readwrite").delete(key); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error);
  });
}
function norm(v) {
  return String(v || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}
function codeKey(v) {
  let key = String(v == null ? "" : v).normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim().replace(/[\s\u00A0-]/g, "").toUpperCase();
  if (/^\d+[.,]0+$/.test(key)) key = key.replace(/[.,]0+$/, "");
  if (/^\d+$/.test(key)) key = key.replace(/^0+(?=\d)/, "");
  return key;
}
function priceText(a) {
  if (a.price === "" || a.price == null || !Number.isFinite(Number(a.price))) return a && a.archiveEntry ? "PREZZO ASSENTE" : "Prezzo non indicato";
  return "€ " + Number(a.price).toFixed(2).replace(".", ",");
}
function status() {
  const online = navigator.onLine;
  $("connection").textContent = online ? t("Connesso — dati conservati sul dispositivo") : t("Offline — puoi utilizzare i dati già salvati");
  $("connection").className = "status " + (online ? "on" : "off");
}
function message(id, text) { if ($(id)) $(id).textContent = t(text); }

/* CLIENTI: il reparto è facoltativo */
async function customersData() { const data = await getValue("meta", "customers"); return data ? data.value : []; }
async function saveCustomers(data) { await put("meta", { key: "customers", value: data }); }
async function refreshCustomers() {
  await refreshDepartments();
  await renderCustomerMatches();
}
function appendCustomerHighlight(host, value, query) {
  const text = String(value || ""), q = String(query || "");
  const at = q ? text.toLocaleLowerCase("it").indexOf(q.toLocaleLowerCase("it")) : -1;
  if (at < 0) { host.append(document.createTextNode(text)); return; }
  host.append(document.createTextNode(text.slice(0, at)));
  const mark = document.createElement("span"); mark.className = "customer-match-highlight";
  mark.textContent = text.slice(at, at + q.length); host.append(mark);
  host.append(document.createTextNode(text.slice(at + q.length)));
}
async function renderCustomerMatches() {
  const host = $("customerMatches");
  if (!host) return;
  const query = $("customer").value.trim(), key = norm(query);
  host.replaceChildren();
  if (!key) { host.classList.add("hidden"); return; }
  const data = await customersData();
  const matches = data.filter(c => norm(c.name).includes(key) || (c.departments || []).some(d => norm(d).includes(key))).slice(0, 12);
  if (!matches.length) { host.classList.add("hidden"); return; }
  const heading = document.createElement("div"); heading.className = "customer-match-heading";
  heading.textContent = "Clienti già presenti — seleziona il nominativo e l'eventuale reparto"; host.append(heading);
  matches.forEach(c => {
    const options = ["", ...(c.departments || [])];
    options.forEach(dep => {
      const button = document.createElement("button"); button.type = "button"; button.className = "customer-match-option";
      const name = document.createElement("span"); name.className = "customer-match-name";
      appendCustomerHighlight(name, c.name, query); button.append(name);
      if (dep) {
        const suffix = document.createElement("span"); suffix.className = "customer-match-department";
        suffix.textContent = " — Rep. " + dep; button.append(suffix);
      } else {
        const suffix = document.createElement("span"); suffix.className = "customer-match-department";
        suffix.textContent = " — senza reparto"; button.append(suffix);
      }
      button.onclick = async () => {
        $("customer").value = c.name;
        await refreshDepartments();
        $("department").value = dep;
        host.classList.add("hidden");
        message("customerMessage", "Cliente già presente: " + c.name + (dep ? " — reparto " + dep : " — senza reparto") + ".");
      };
      host.append(button);
    });
  });
  host.classList.remove("hidden");
}
async function refreshDepartments() {
  const data = await customersData(), customer = norm($("customer").value), selected = $("department").value;
  const found = data.find(c => norm(c.name) === customer), select = $("department");
  select.replaceChildren();
  const first = document.createElement("option"); first.value = ""; first.textContent = "Nessun reparto / seleziona"; select.append(first);
  if (found) (found.departments || []).forEach(dep => { const o = document.createElement("option"); o.value = dep; o.textContent = dep; select.append(o); });
  if ([...select.options].some(o => o.value === selected)) select.value = selected;
}
async function saveCustomerDepartment() {
  const name = $("customer").value.trim(), department = $("newDepartment").value.trim();
  if (!name) { message("customerMessage", "Inserisci prima il cliente."); return; }
  if (!department) { message("customerMessage", "Scrivi il nome del reparto."); return; }
  const data = await customersData();
  let c = data.find(x => norm(x.name) === norm(name));
  if (!c) { c = { name, departments: [] }; data.push(c); }
  c.departments = c.departments || [];
  if (!c.departments.includes(department)) c.departments.push(department);
  await saveCustomers(data); $("newDepartment").value = "";
  await refreshCustomers(); $("department").value = department;
  await renderCustomerMatches();
  message("customerMessage", "Cliente e reparto salvati.");
}
async function loadCustomerBusinessCard() {
  const name=$("customer").value.trim();
  const data=await customersData();
  const customer=data.find(c=>norm(c.name)===norm(name));
  currentBusinessCardPhoto=customer && customer.businessCardPhoto ? customer.businessCardPhoto : "";
  const statusNode=$("businessCardStatus");
  if(statusNode)statusNode.textContent=currentBusinessCardPhoto?"Foto biglietto già salvata per questo cliente.":"Nessuna foto del biglietto salvata.";
  const deleteButton=$("deleteBusinessCardPhoto");if(deleteButton)deleteButton.classList.toggle("hidden",!currentBusinessCardPhoto);
}
async function ensureCustomer() {
  const name = $("customer").value.trim(), department = $("department").value;
  if (!name) { message("customerMessage", "Seleziona o inserisci il cliente prima di aggiungere articoli."); $("customer").focus(); return false; }
  const data = await customersData();
  let c = data.find(x => norm(x.name) === norm(name));
  if (!c) { c = { name, departments: [] }; data.push(c); }
  c.departments = c.departments || [];
  if (currentBusinessCardPhoto) c.businessCardPhoto=currentBusinessCardPhoto;
  if (department && !c.departments.includes(department)) c.departments.push(department);
  await saveCustomers(data);
  message("customerMessage", department ? "Cliente e reparto selezionati." : "Cliente selezionato. Reparto facoltativo.");
  return true;
}

/* ARCHIVIO E RICERCA */
async function getPriceListRows() {
  const lists = await all("priceLists");
  if (lists.length) return lists.flatMap(list => (list.rows || []).map(row => ({...row, listinoId:list.id, listinoName:list.name})));
  const initialized=await getValue("meta","priceListsInitialized");
  if(initialized && initialized.value===true)return [];
  return (await all("articles")).map(row => ({...row, listinoName:"Listino precedente"}));
}
async function refreshListinoInfo() {
  const lists = await all("priceLists");
  const initialized=await getValue("meta","priceListsInitialized");
  if (lists.length) {
    $("listinoInfo").textContent = lists.length + " listini caricati — " + lists.reduce((n,x)=>n+(x.rows||[]).length,0) + " righe articolo.";
  } else if(!initialized) {
    const legacy = await getValue("meta","activeListino");
    const count = (legacy && legacy.value && legacy.value.rows && legacy.value.rows.length) || articles.length;
    $("listinoInfo").textContent = count ? "Listino precedente: " + count + " articoli." : "Nessun listino caricato.";
  } else $("listinoInfo").textContent="Nessun listino caricato.";
  await renderListinoManager();
}
async function renderListinoManager() {
  const host=$("priceListsList"); if(!host)return;
  const lists=await all("priceLists"); host.replaceChildren();
  if(!lists.length){host.textContent="Nessun listino caricato.";return;}
  lists.sort((a,b)=>(a.importedAt||"").localeCompare(b.importedAt||""));
  lists.forEach(list=>{
    const row=document.createElement("div");row.className="article";
    const title=document.createElement("strong");title.textContent=list.name||"Listino senza nome";
    const info=document.createElement("div");info.className="muted";info.textContent=(list.rows||[]).length+" articoli · "+(list.type||"file");
    const del=document.createElement("button");del.className="danger";del.textContent="Elimina questo listino";
    del.onclick=async()=>{if(!confirm("Eliminare il listino "+(list.name||"selezionato")+"? Le selezioni salvate e l’archivio articoli permanente non verranno eliminati."))return;
      await removeRecord("priceLists",list.id);
      const remaining=await all("priceLists");activeListino=remaining.length?remaining[remaining.length-1]:null;
      await put("meta",{key:"activeListino",value:activeListino});
      await put("meta",{key:"priceListsInitialized",value:true});
      await refreshArticles();await refreshListinoInfo();await renderResults();
      message("importMessage","Listino eliminato. Gli altri listini e gli archivi sono rimasti invariati.");};
    row.append(title,info,del);host.append(row);
  });
}
async function addPriceList(name,type,rows) {
  const list={id:crypto.randomUUID(),name,type,rows:rows.map(a=>({...a})),importedAt:new Date().toISOString()};
  await put("priceLists",list);
  await put("meta",{key:"priceListsInitialized",value:true});
  activeListino=list;
  await put("meta",{key:"activeListino",value:list});
  await refreshArticles();
  await refreshListinoInfo();
  return list;
}
async function restoreActiveListino() {
  let lists=await all("priceLists");
  if(!lists.length){
    const saved=await getValue("meta","activeListino");
    if(saved && saved.value && Array.isArray(saved.value.rows) && saved.value.rows.length){
      const old=saved.value;
      const migrated={id:crypto.randomUUID(),name:old.name||"Listino importato in precedenza",type:"legacy",rows:old.rows,importedAt:old.importedAt||new Date().toISOString()};
      await put("priceLists",migrated);
      lists=[migrated];
    }
  }
  await put("meta",{key:"priceListsInitialized",value:true});
  activeListino=lists.length?lists[lists.length-1]:null;
  if(activeListino) renderPdfPreview(activeListino.rows,activeListino.name||"Listino caricato",true);
  await refreshListinoInfo();
}
async function refreshArticles() {
  const rows=await getPriceListRows();
  const byCode=new Map();
  rows.forEach(a=>{const key=codeKey(a.code);if(key&&!byCode.has(key))byCode.set(key,a);});
  articles=[...byCode.values()];
  await renderListinoManager();
  renderResults();
}
function showSelectedImportFile(inputId, labelId, fallback) {
  const file = $(inputId).files && $(inputId).files[0];
  $(labelId).textContent = file ? "File selezionato: " + file.name : fallback;
}
async function archiveAsArticle(entry) {
  const base = articles.find(a => norm(a.name) === norm(entry.baseName));
  const variant = normalizeVariantLabel(entry.variant || "");
  return { code:entry.code, name:entry.baseName + (variant ? " — " + variant : ""),
    price:base && base.price != null ? base.price : "", currency:(base && base.currency)||"EUR",
    originalFields:(base && base.originalFields)||{}, archiveEntry:true, baseName:entry.baseName, variant };
}
function normalizeVariantLabel(value) {
  const raw=String(value||"").trim(), m=raw.match(/^(?:S\.?\s*|SERIE\s*)(\d+[A-Za-z]?)$/i);
  return m ? "SERIE "+m[1].toUpperCase() : raw;
}
async function renderResults() {
  const query=norm($("search").value), host=$("results"); host.replaceChildren();
  const priceRows=await getPriceListRows();
  const archive=await all("productArchive"), archiveArticles=await Promise.all(archive.map(archiveAsArticle));
  const found=[...priceRows,...archiveArticles]
    .filter((a,i,arr)=>arr.findIndex(x=>codeKey(x.code)===codeKey(a.code)&&norm(x.name)===norm(a.name)&&String(x.price||"")===String(a.price||""))===i)
    .filter(a=>!query||norm(a.name).includes(query)||String(a.code).includes(query))
    .sort((a,b)=>String(a.name||"").localeCompare(String(b.name||""),"it",{sensitivity:"base",numeric:true}));
  if(!found.length){host.textContent=t("Nessun articolo trovato.");applyLanguage();return;}
  found.forEach(a=>{
    const div=document.createElement("div");div.className="article";
    const name=document.createElement("strong");name.textContent=a.name;
    const details=document.createElement("div");details.className="price";details.textContent=t("Codice ")+a.code+" · "+priceText(a)+(a.listinoName?" · "+a.listinoName:"")+(a.archiveEntry?" · Archivio articoli":"");
    const button=document.createElement("button");button.textContent="Aggiungi alla scelta";
    button.onclick=async()=>{if(await ensureCustomer())addArticle(a);};
    div.append(name,details,button);host.append(div);
  });
  applyLanguage();
}
function addArticle(a) {
  if (currentItems.some(x => x.code && codeKey(x.code) === codeKey(a.code))) {
    message("scanMessage", "Articolo già presente nella scelta: " + a.name + " — " + priceText(a));
    return false;
  }
  currentItems.push({ code:a.code, name:a.name, price:a.price, currency:a.currency || "EUR", quantity:"", quantitySet:false, note:"", originalFields:a.originalFields || {}, manual:false, archiveEntry:!!a.archiveEntry, baseName:a.baseName||"", variant:a.variant||"", listinoId:a.listinoId||"", listinoName:a.listinoName||"" });
  renderChoice(); autosaveDraft(); return true;
}



/* ARCHIVIO PERMANENTE DI ARTICOLI E VARIANTI */
async function renderProductArchive() {
  const host=$("productArchiveList"); if(!host)return;
  const rows=(await all("productArchive")).sort((a,b)=>(a.baseName+" "+a.variant).localeCompare(b.baseName+" "+b.variant,"it",{numeric:true,sensitivity:"base"}));
  host.replaceChildren();
  if(!rows.length){host.textContent="Nessun articolo ancora archiviato.";return;}
  rows.forEach(entry=>{
    const row=document.createElement("div");row.className="article";
    const title=document.createElement("strong");title.textContent=entry.baseName+" — "+normalizeVariantLabel(entry.variant);
    const info=document.createElement("div");info.className="price";info.textContent="Codice "+entry.code;
    const del=document.createElement("button");del.className="danger";del.textContent="Elimina";
    del.onclick=async()=>{if(confirm("Eliminare questa variante dall’archivio permanente?")){await removeRecord("productArchive",entry.code);await renderProductArchive();await renderResults();}};
    row.append(title,info,del);host.append(row);
  });
}
async function addProductArchiveEntry() {
  const baseName=$("archiveBaseName").value.trim(), variant=normalizeVariantLabel($("archiveVariant").value), code=$("archiveCode").value.trim();
  if(!baseName||!variant||!code){message("productArchiveMessage","Inserisci nome articolo, serie/disegno e codice.");return;}
  const existing=await getValue("productArchive",code);
  if(existing&&!confirm("Questo codice è già presente. Vuoi sostituire la sua associazione?"))return;
  await put("productArchive",{code,baseName,variant,updatedAt:new Date().toISOString()});
  $("archiveBaseName").value="";$("archiveVariant").value="";$("archiveCode").value="";
  lastUnknownCode="";if($("archiveUnknownCode"))$("archiveUnknownCode").classList.add("hidden");
  message("productArchiveMessage","Variante salvata nell’archivio permanente.");
  await renderProductArchive();await renderResults();
}

/* SCELTA ARTICOLI */
function renderChoice() {
  // Ripulisce anche le selezioni già salvate con doppioni creati da versioni precedenti.
  const seenCodes = new Set();
  currentItems = currentItems.filter(item => {
    if (!item || !item.code) return true; // gli articoli manuali non hanno codice
    const key = codeKey(item.code);
    if (!key || seenCodes.has(key)) return false;
    seenCodes.add(key);
    return true;
  });
  const host = $("choiceItems"); host.replaceChildren();
  if (!currentItems.length) { host.textContent = t("Nessun articolo selezionato."); renderRecentScans(); applyLanguage(); return; }
  currentItems.forEach((item,index) => {
    const div = document.createElement("div"); div.className = "item";
    const name = document.createElement("strong"); name.textContent = item.name;
    const details = document.createElement("div"); details.className = "muted";
    details.textContent = (item.code ? t("Codice ") + item.code + " · " : "") + priceText(item);
    const grid = document.createElement("div"); grid.className = "itemgrid";
    const qty = document.createElement("input");
    // I vecchi "1" erano valori automatici: non mostrarli come quantità.
    if (item.quantity === "1" && item.quantitySet !== true) item.quantity = "";
    qty.value = item.quantity || ""; qty.placeholder = "Metri (facoltativo)";
    qty.onchange = () => { item.quantity = qty.value.trim(); item.quantitySet = !!item.quantity; autosaveDraft(); };
    const remove = document.createElement("button"); remove.className = "danger"; remove.textContent = "Rimuovi";
    remove.onclick = () => {
      const removed = currentItems[index]; currentItems.splice(index,1);
      recentScans = recentScans.filter(x => !(x.code && removed.code && codeKey(x.code) === codeKey(removed.code)));
      renderChoice(); autosaveDraft(); renderRecentScans();
    };
    const note = document.createElement("textarea"); note.placeholder = "Nota articolo"; note.value = item.note || "";
    note.onchange = () => { item.note = note.value; autosaveDraft(); };
    grid.append(qty,remove); div.append(name,details,grid,note); host.append(div);
  });
  renderRecentScans();
  applyLanguage();
}
function choicePayload() {
  return {
    id:currentChoiceId || crypto.randomUUID(),
    date:$("choiceDate").value,
    number:$("choiceNumber").value.trim(),
    customer:$("customer").value.trim(),
    department:$("department").value,
    note:$("generalNote").value,
    conditions:$("commercialConditions").value,
    documentType:$("documentType").value,
    includeDetails:$("includeDetails").checked,
    includePrices:$("includePrices").checked,
    items:currentItems,
    updatedAt:new Date().toISOString()
  };
}


async function autosaveDraft() { if (currentChoiceId) await put("choices", choicePayload()); }
function newChoice() {
  currentChoiceId = crypto.randomUUID();
  currentItems = [];
  recentScans = [];
  $("choiceDate").value = new Date().toISOString().slice(0,10);
  $("choiceNumber").value = "";
  $("customer").value = "";
  currentBusinessCardPhoto = "";
  if($("businessCardStatus"))$("businessCardStatus").textContent="Nessuna foto del biglietto salvata.";
  if($("businessCardPhoto"))$("businessCardPhoto").value="";
  $("department").value = "";
  $("newDepartment").value = "";
  $("search").value = "";
  $("generalNote").value = "";
  $("commercialConditions").value = "";
  $("documentType").value = "summary";
  $("includeDetails").checked = false;
  $("includePrices").checked = false;
  $("manualAdd").classList.add("hidden");
  $("reader").classList.add("hidden");
  $("results").classList.remove("hidden");
  renderChoice();
  renderRecentScans();
  refreshDepartments();
  window.scrollTo({top:0,behavior:"smooth"});
}


async function ensureSelectionNumber() {
  const existing = $("choiceNumber").value.trim();
  if (existing) return existing;
  const year = new Date().getFullYear();
  const key = "selectionSequence-" + year;
  const saved = await all("choices");
  const used = saved.map(c => {
    const m = String(c.number || "").match(/^(\d+)\/(\d{4})$/);
    return m && Number(m[2]) === year ? Number(m[1]) : 0;
  });
  const meta = await getValue("meta", key);
  const next = Math.max(Number(meta && meta.value) || 0, ...used) + 1;
  await put("meta", {key, value:next});
  $("choiceNumber").value = next + "/" + year;
  return $("choiceNumber").value;
}

async function saveChoice() {
  if (!await ensureCustomer()) return;
  if (!currentItems.length) {
    message("documentMessage", "Aggiungi almeno un articolo prima di salvare.");
    return;
  }
  await ensureSelectionNumber();
  const data = choicePayload();
  data.updatedAt = new Date().toISOString();
  await put("choices", data);
  await renderSaved();
  const savedNumber = data.number;
  newChoice();
  message("documentMessage", "Selezione " + savedNumber + " salvata. Inserisci il prossimo cliente.");
}


async function renderSaved() {
  const host = $("savedChoices");
  const query = norm($("savedSearch").value);
  const choices = (await all("choices"))
    .filter(c => !query || norm(c.customer).includes(query) || norm(c.number).includes(query))
    .sort((a,b) => (b.updatedAt||"").localeCompare(a.updatedAt||""));
  host.replaceChildren();
  if (!choices.length) {
    host.textContent = t(query ? "Nessuna selezione corrispondente." : "Nessuna scelta salvata.");
    applyLanguage();
    return;
  }
  choices.forEach(c => {
    const div = document.createElement("div");
    div.className = "article saved-choice";
    const title = document.createElement("strong");
    title.textContent = t("Selezione N.") + " " + (c.number || "—") + " · " + (c.customer || "Senza cliente");
    const info = document.createElement("div");
    info.className = "muted";
    info.textContent = (c.date || "") + (c.department ? " · " + c.department : "") + " · " + (c.items||[]).length + " " + t("articoli");
    const actions = document.createElement("div");
    actions.className = "row saved-actions";
    const open = document.createElement("button");
    open.className = "secondary";
    open.textContent = "Apri selezione";
    open.onclick = async () => {
      currentChoiceId = c.id;
      $("choiceDate").value = c.date || "";
      $("choiceNumber").value = c.number || "";
      $("customer").value = c.customer || "";
      await loadCustomerBusinessCard();
      await refreshDepartments();
      $("department").value = c.department || "";
      $("generalNote").value = c.note || "";
      $("commercialConditions").value = c.conditions || "";
      $("documentType").value = c.documentType || "summary";
      $("includeDetails").checked = c.includeDetails === true;
      $("includePrices").checked = c.includePrices === true;
      currentItems = c.items || [];
      recentScans = [];
      renderChoice();
      window.scrollTo({top:0,behavior:"smooth"});
    };
    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "Elimina selezione";
    del.onclick = async () => {
      if (!confirm("Eliminare definitivamente la selezione " + (c.number || "") + " di " + (c.customer || "") + "?")) return;
      await removeRecord("choices", c.id);
      if (currentChoiceId === c.id) newChoice();
      await renderSaved();
      message("documentMessage", "Selezione eliminata. Il numero progressivo non verrà riutilizzato.");
    };
    actions.append(open, del);
    div.append(title, info, actions);
    host.append(div);
  });
  applyLanguage();
}


// Gli articoli letti vengono mostrati una sola volta nella selezione sottostante.
// Manteniamo queste funzioni vuote per compatibilità con i richiami storici.
function rememberRecentScan(a) { /* visualizzazione unica in Articoli selezionati */ }
function renderRecentScans() { /* elenco duplicato rimosso dall'interfaccia */ }

/* INSERIMENTO MANUALE */
async function addManual() {
  if (!await ensureCustomer()) return;
  const name=$("manualName").value.trim(); if(!name){alert("Inserisci il nome dell'articolo.");return;}
  currentItems.push({code:"",name,price:$("manualPrice").value||"",currency:"EUR",
    quantity:$("manualQty").value.trim(),quantitySet:!!$("manualQty").value.trim(),note:$("manualNote").value.trim(),originalFields:{},manual:true});
  $("manualName").value=""; $("manualPrice").value=""; $("manualQty").value=""; $("manualNote").value="";
  $("manualAdd").classList.add("hidden"); renderChoice(); autosaveDraft();
}

/* SUONO, VIBRAZIONE E WAKE LOCK */
async function prepareAudio() {
  try {
    const Ctx=window.AudioContext||window.webkitAudioContext;
    if(!Ctx) return;
    if(!audioContext) audioContext=new Ctx();
    if(audioContext.state==="suspended") await audioContext.resume();
  } catch(e) { /* audio non supportato o bloccato */ }
}
function beep() {
  try {
    if(!audioContext || audioContext.state!=="running") return;
    const osc=audioContext.createOscillator(), gain=audioContext.createGain();
    osc.type="sine"; osc.frequency.value=880; gain.gain.setValueAtTime(0.0001,audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18,audioContext.currentTime+0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001,audioContext.currentTime+0.19);
    osc.connect(gain); gain.connect(audioContext.destination); osc.start(); osc.stop(audioContext.currentTime+0.2);
  } catch(e) {}
}
function vibrateScan() { try { if(navigator.vibrate) navigator.vibrate(70); } catch(e) {} }
async function requestScreenWakeLock() {
  try { if("wakeLock" in navigator) screenWakeLock=await navigator.wakeLock.request("screen"); } catch(e) {}
}
async function releaseScreenWakeLock() {
  try { if(screenWakeLock) await screenWakeLock.release(); } catch(e) {}
  screenWakeLock=null;
}

/* SCANNER: html5-qrcode locale. Configurazione allineata alla pagina scanner dedicata,
   che usa una zona di lettura ampia per i codici a barre lineari su iPhone. */
function scannerCameraError(error) {
  const name=error&&error.name?error.name:"";
  if(name==="NotAllowedError"||name==="PermissionDeniedError")
    return "Permesso fotocamera negato. Consenti l'accesso alla fotocamera per questo sito nelle impostazioni del browser.";
  if(name==="NotFoundError"||name==="DevicesNotFoundError")
    return "Non trovo una fotocamera disponibile sul dispositivo.";
  if(name==="NotReadableError"||name==="TrackStartError")
    return "La fotocamera è occupata da un'altra app. Chiudi le altre app che la usano e riprova.";
  if(name==="SecurityError"||!window.isSecureContext)
    return "La fotocamera richiede HTTPS. Apri l'app dal suo indirizzo GitHub Pages sicuro.";
  return error&&error.message?error.message:"Non è stato possibile avviare la fotocamera.";
}

async function startScanner() {
  if(scanner){ await stopScanner(); return; }
  if(!window.isSecureContext){
    message("scanMessage","La fotocamera richiede HTTPS. Apri l'app dal suo indirizzo GitHub Pages.");
    return;
  }
  if(typeof Html5Qrcode==="undefined" || typeof Html5QrcodeSupportedFormats==="undefined"){
    message("scanMessage","Lettore codici non disponibile. Ricarica l'app online e riprova.");
    return;
  }

  const reader=$("reader"), button=$("startScan");
  reader.classList.remove("hidden");
  $("results").classList.add("hidden");
  button.disabled=true;
  message("scanMessage","Avvio fotocamera e lettore codici…");
  try{
    // Le opzioni di lettura sono passate a start(), come nella pagina scanner
    // dedicata inclusa nel progetto. Evitiamo vincoli video rigidi che su alcuni
    // Safari iOS possono aprire la camera ma impedire l'analisi dei fotogrammi.
    scanner=new Html5Qrcode("reader");
    const config={
      fps:20,
      qrbox:(viewfinderWidth,viewfinderHeight)=>({
        width:Math.floor(viewfinderWidth*0.94),
        height:Math.floor(viewfinderHeight*0.58)
      }),
      formatsToSupport:[
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E,
        Html5QrcodeSupportedFormats.CODE_128,
        Html5QrcodeSupportedFormats.CODE_39,
        Html5QrcodeSupportedFormats.ITF
      ],
      rememberLastUsedCamera:true
    };
    await scanner.start({facingMode:"environment"},config,decodedText=>{
      const code=normalizeBarcodeCode(decodedText), now=Date.now();
      if(!code||(code===lastScan&&now-lastScanAt<1800)||scanBusy)return;
      lastScan=code; lastScanAt=now; scanBusy=true;
      Promise.resolve(onBarcode(code)).catch(error=>{
        message("scanMessage","Errore durante la ricerca dell'articolo: "+(error&&error.message?error.message:"riprova"));
      }).finally(()=>setTimeout(()=>{scanBusy=false;},500));
    },()=>{});
    button.textContent="Chiudi scanner";
    button.disabled=false;
    try{await prepareAudio();}catch(e){}
    try{await requestScreenWakeLock();}catch(e){}
    message("scanMessage","Scanner attivo: centra il codice a barre nella cornice, in orizzontale, e attendi la messa a fuoco. Il nome dell'articolo apparirà dopo la lettura.");
  }catch(e){
    try{if(scanner){await scanner.stop().catch(()=>{});await scanner.clear().catch(()=>{});}}catch(ignore){}
    scanner=null;
    reader.classList.add("hidden");
    $("results").classList.remove("hidden");
    button.textContent="Apri fotocamera e scansiona";
    button.disabled=false;
    message("scanMessage","Scanner non avviato: "+scannerCameraError(e));
  }
}

async function stopScanner(){
  const active=scanner;
  scanner=null;
  if(active){
    try{await active.stop();}catch(e){}
    try{await active.clear();}catch(e){}
  }
  $("reader").classList.add("hidden");
  $("results").classList.remove("hidden");
  $("startScan").textContent="Apri fotocamera e scansiona";
  await releaseScreenWakeLock();
  message("scanMessage","Scanner fermato.");
}

function normalizeBarcodeCode(value) {
  return String(value==null?"":value).normalize("NFKC").trim().replace(/[\s-]/g,"");
}
function scannerMatchKey(value) {
  let s = String(value == null ? "" : value).normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim().replace(/[\s\u00A0-]/g, "").toUpperCase();
  // Alcuni fogli di calcolo trasformano i codici numerici in 8602.0.
  if (/^\d+[.,]0+$/.test(s)) s = s.replace(/[.,]0+$/, "");
  // Codice barcode (es. 00008602) e codice listino (8602): confronta
  // senza gli zeri iniziali, senza modificare il valore salvato.
  if (/^\d+$/.test(s)) return s.replace(/^0+(?=\d)/, "");
  return s;
}

async function onBarcode(code) {
  const scanned = normalizeBarcodeCode(code);
  const scannedKey = scannerMatchKey(scanned);
  const sources = await getPriceListRows();
  const matches=sources.filter(x=>scannerMatchKey(x&&x.code)===scannedKey && scannedKey!=="");
  const distinct=matches.filter((x,i,arr)=>arr.findIndex(y=>norm(y.name)===norm(x.name)&&String(y.price||"")===String(x.price||""))===i);
  if(distinct.length>1){
    $("search").value=scanned;
    await renderResults();
    $("results").classList.remove("hidden");
    message("scanMessage","Codice presente in più listini con dati/prezzi diversi. Scegli la riga corretta dall’elenco.");
    return;
  }
  let a = distinct[0] || null;
  if (!a) {
    const archived=(await all("productArchive")).find(x=>scannerMatchKey(x.code)===scannedKey);
    if(archived)a=await archiveAsArticle(archived);
  }
  const scanStatus = $("scanMessage");
  if (a) {
    if (!await ensureCustomer()) {
      if (scanStatus) scanStatus.className = "status off";
      message("scanMessage", "Codice letto: " + scanned + ". Seleziona prima il cliente.");
      return;
    }
    const added = addArticle(a);
    if (added) {
      rememberRecentScan(a);
      if (scanStatus) scanStatus.className = "status on";
      beep(); vibrateScan();
      message("scanMessage", "ARTICOLO AGGIUNTO: " + a.name + " — " + priceText(a));
    } else {
      if (scanStatus) scanStatus.className = "status scan-duplicate";
      message("scanMessage", "ARTICOLO GIÀ PRESENTE nella selezione: " + a.name + ". Nessun nuovo inserimento.");
    }
    return;
  }
  if (scanStatus) scanStatus.className = "status scan-missing";
  lastUnknownCode=scanned;
  if($("archiveUnknownCode"))$("archiveUnknownCode").classList.remove("hidden");
  message("scanMessage", "ARTICOLO NON IN LISTINO: " + scanned + ". Puoi inserirlo manualmente o registrarlo nell’archivio.");
  $("manualAdd").classList.remove("hidden");
  $("manualName").value = ""; $("manualQty").value = ""; $("manualName").focus();
}

/* CSV / EXCEL */
function parseCsv(text) {
  const lines=text.replace(/^\uFEFF/,"").split(/\r?\n/).filter(x=>x.trim()); if(!lines.length)return[];
  const delimiter=(lines[0].match(/;/g)||[]).length>(lines[0].match(/,/g)||[]).length?";":",";
  function parseLine(line){const out=[];let value="",quoted=false;for(let i=0;i<line.length;i++){const c=line[i];
    if(c==='"'&&line[i+1]==='"'&&quoted){value+='"';i++;}else if(c==='"')quoted=!quoted;
    else if(c===delimiter&&!quoted){out.push(value.trim());value="";}else value+=c;}out.push(value.trim());return out;}
  const rows=lines.map(parseLine), header=rows[0].map(norm);
  const hasHeader=header.some(x=>["codice","code","articolo","nome","descrizione"].includes(x));
  return rows.slice(hasHeader?1:0).map(r=>({code:String(r[0]||"").trim(),name:String(r[1]||"").trim(),currency:"EUR",
    price:String(r[3]||r[2]||"").replace(",",".").trim(),originalFields:{columns:r}})).filter(a=>a.code&&a.name);
}
async function mergeArticles(rows) {
  let count=0; for(const a of rows){if(!a.code||!a.name)continue;await put("articles",{...a,code:String(a.code).trim(),name:String(a.name).trim()});count++;}
  await refreshArticles(); return count;
}
async function replaceActiveArticles(rows) {
  await new Promise((resolve,reject)=>{
    const tx=db.transaction("articles","readwrite"), os=tx.objectStore("articles"); os.clear();
    rows.forEach(a=>{if(a.code&&a.name)os.put({...a,code:String(a.code).trim(),name:String(a.name).trim()});});
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
  });
  await refreshArticles();return rows.filter(a=>a.code&&a.name).length;
}
async function importCsv() {
  const file=$("csvFile").files[0];if(!file){alert("Seleziona un file CSV.");return;}
  try{const rows=parseCsv(await file.text());if(!rows.length)throw new Error("Nessun articolo riconosciuto.");
    const list=await addPriceList(file.name,"CSV",rows);const n=rows.length;
    message("importMessage", "Listino " + file.name + ": " + n + " articoli aggiunti. I listini precedenti restano disponibili.");}
  catch(e){message("importMessage","Errore CSV: "+e.message);}
}
function excelHeaderKey(value) {
  return norm(String(value == null ? "" : value))
    .replace(/[àá]/g,"a").replace(/[èé]/g,"e").replace(/[ì]/g,"i").replace(/[ò]/g,"o").replace(/[ù]/g,"u")
    .replace(/[^a-z0-9]/g, "");
}
function findExcelHeader(headers, aliases) {
  const keys = aliases.map(excelHeaderKey);
  return headers.findIndex(h => keys.includes(excelHeaderKey(h)));
}
function excelCell(row, index) {
  return index >= 0 && row[index] != null ? String(row[index]).trim() : "";
}
function parseFlexibleExcel(data) {
  // Individua la riga intestazioni anche se il foglio contiene titolo e righe vuote sopra.
  let headerRow = -1, headers = [], map = null, best = 0;
  const aliases = {
    code: ["codice", "codice articolo", "codicearticolo", "code", "barcode", "ean", "ean13", "articolo codice"],
    name: ["articolo", "nome articolo", "nomearticolo", "descrizione", "descrizione articolo", "nome", "item", "product", "prodotto"],
    price: ["prezzo", "prezzo unitario", "prezzounitario", "price", "valore", "euro"],
    composition: ["composizione", "composition", "materiale", "composizione articolo"],
    weight: ["peso", "weight", "grammi", "gr/mq", "grmq"],
    height: ["altezze", "altezza", "height", "misure", "altezza cm"],
    fullDescription: ["dettagli", "dettagli originali", "descrizione completa", "note articolo", "specifiche", "full description"]
  };
  for (let i=0; i<Math.min(data.length,20); i++) {
    const row = data[i] || [];
    const candidate = {};
    for (const [field, names] of Object.entries(aliases)) candidate[field] = findExcelHeader(row, names);
    const score = Object.values(candidate).filter(v => v >= 0).length;
    if (candidate.name >= 0 && candidate.code >= 0 && score > best) {
      best=score; headerRow=i; headers=row.map(v=>String(v==null?"":v).trim()); map=candidate;
    }
  }
  if (headerRow < 0) throw new Error("Non trovo le intestazioni CODICE e ARTICOLO. Inserisci i nomi delle colonne nella riga di intestazione.");
  const rows=[];
  for (const row of data.slice(headerRow+1)) {
    if (!row || !row.some(v=>String(v==null?"":v).trim())) continue;
    const code=excelCell(row,map.code), name=excelCell(row,map.name);
    if (!code || !name) continue;
    const originalFields={columns:row, headers};
    for (const field of ["composition","weight","height","fullDescription"]) {
      const value=excelCell(row,map[field]); if(value) originalFields[field]=value;
    }
    // Conserva anche le altre colonne non vuote, senza imporre un modello fisso.
    const extras=[];
    row.forEach((value,i)=>{const v=String(value==null?"":value).trim();if(v){extras.push({label:headers[i]||("Colonna "+(i+1)),value:v});}});
    originalFields.extras=extras;
    const price=excelCell(row,map.price);
    rows.push({code,name,currency:"EUR",price:price.replace(",","."),originalFields});
  }
  return rows;
}
async function importExcel() {
  const file=$("excelFile").files[0];if(!file){alert("Seleziona un file Excel.");return;}
  if(!window.XLSX){message("importMessage","Lettore Excel non disponibile. Apri l'app online una volta.");return;}
  try{
    const workbook=XLSX.read(await file.arrayBuffer(),{type:"array"});
    let rows=[];
    // Prova i fogli in ordine: usa il primo che contiene intestazioni e articoli validi.
    for(const sheetName of workbook.SheetNames){
      const data=XLSX.utils.sheet_to_json(workbook.Sheets[sheetName],{header:1,defval:""});
      try{rows=parseFlexibleExcel(data);if(rows.length)break;}catch(e){/* prova il foglio successivo */}
    }
    if(!rows.length)throw new Error("Nessun articolo riconosciuto. Verifica che ci siano le colonne CODICE e ARTICOLO.");
    await addPriceList(file.name,"Excel",rows);const n=rows.length;
    message("importMessage", "Listino " + file.name + ": " + n + " articoli aggiunti. I listini precedenti restano disponibili; le colonne riconosciute sono state associate automaticamente.");
  } catch(e){message("importMessage","Errore Excel: "+e.message);}
}

/* PDF / OCR */
async function loadTesseract() {
  if(window.Tesseract)return window.Tesseract;
  await new Promise((resolve,reject)=>{const s=document.createElement("script");s.src="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    s.onload=resolve;s.onerror=()=>reject(new Error("Impossibile caricare il motore OCR."));document.head.append(s);});
  return window.Tesseract;
}
async function extractPdfText(file) {
  if(!window.pdfjsLib)throw new Error("Lettore PDF non disponibile.");
  pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const pdf=await pdfjsLib.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
  const lines=[];let ocrWorker=null;
  for(let p=1;p<=pdf.numPages;p++){
    message("pdfMessage","Lettura pagina "+p+" di "+pdf.numPages);
    const page=await pdf.getPage(p),content=await page.getTextContent(),rows=[];
    content.items.forEach(item=>{if(!item.str||!item.str.trim())return;const y=Math.round(item.transform[5]);
      let row=rows.find(r=>Math.abs(r.y-y)<=3);if(!row){row={y,parts:[]};rows.push(row);}row.parts.push({x:item.transform[4],text:item.str.trim()});});
    const pageLines=rows.sort((a,b)=>b.y-a.y).map(r=>r.parts.sort((a,b)=>a.x-b.x).map(x=>x.text).join(" ").replace(/\s+/g," ").trim()).filter(Boolean);
    if(pageLines.join("").replace(/\s/g,"").length>25)lines.push(...pageLines);
    else{
      if(!ocrWorker){const T=await loadTesseract();ocrWorker=await T.createWorker("ita");}
      const viewport=page.getViewport({scale:2}),canvas=document.createElement("canvas");canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
      await page.render({canvasContext:canvas.getContext("2d"),viewport}).promise;
      const result=await ocrWorker.recognize(canvas);lines.push(...String(result.data.text||"").split(/\r?\n/).map(x=>x.trim()).filter(Boolean));
      canvas.width=0;canvas.height=0;
    }
  }
  if(ocrWorker)await ocrWorker.terminate();return lines;
}
function parsePdfLines(lines) {
  const out=[],seen=new Set(),text=lines.map(x=>String(x).trim()).filter(Boolean);
  const pricePattern=/(?:EURO|EUR|€)?\s*(\d{1,4}[,.]\d{2})(?!\d)/i,codePattern=/^\d{3,8}$/;
  for(let i=0;i<text.length;i++){
    const line=text[i],start=line.match(/^(\d{3,8})\s+(.+)$/);let code="",description="";
    if(start){code=start[1];description=start[2];}else if(codePattern.test(line))code=line;else continue;
    if(seen.has(code))continue;
    const collected=[description];let price=null,original=[],afterPrice="";
    for(let j=i;j<Math.min(i+8,text.length);j++){
      const current=text[j];original.push(current);const m=current.match(pricePattern);
      if(m){
        price=Number(m[1].replace(",","."));
        afterPrice=current.slice(m.index+m[0].length).trim();
        break;
      }
      if(j>i&&!codePattern.test(current))collected.push(current);
    }
    if(price===null||!Number.isFinite(price))continue;
    const combined=collected.join(" ").replace(/\s+/g," ").trim();
    const composition=combined.match(/(?:PL|WO|PA|PC|SE|CO|VI|LI|EA|AC|NY|WV|WS)\s*\d+\s*%.*$/i);
    let name=combined,compositionText="";
    if(composition){compositionText=composition[0].replace(/\bEURO\b.*$/i,"").trim();name=combined.slice(0,composition.index).trim();}
    name=name.replace(/\bEURO\b.*$/i,"").trim();if(!name)continue;
    const suffix=afterPrice.split(/\s+/).filter(Boolean);
    const heightIndex=suffix.findIndex(v=>/^\d{2,3}\s*\/\s*\d{2,3}$/.test(v));
    const height=heightIndex>=0?suffix[heightIndex].replace(/\s+/g,""):"";
    const weights=suffix.filter((v,k)=>k!==heightIndex&&/^\d+(?:[,.]\d+)?$/.test(v));
    const originalFields={originalLines:original,composition:compositionText,weight:weights.length?weights.join(" / "):"",height,fullDescription:""};
    out.push({code,name,price:String(price),currency:"EUR",originalFields});seen.add(code);
  }
  return out;
}
function renderPdfPreview(rows, listinoName="", imported=false) {
  const host=$("pdfPreviewList");host.replaceChildren();
  rows.forEach(a=>{const row=document.createElement("div");row.className="pdf-row";const info=document.createElement("div");
    const name=document.createElement("strong");name.textContent=a.name;const code=document.createElement("small");code.textContent="Codice "+a.code;
    info.append(name,code);const price=document.createElement("b");price.className="pdf-price";price.textContent=priceText(a);row.append(info,price);host.append(row);});
  $("pdfPreviewCount").textContent=(imported?"Listino caricato: ":"Anteprima: ")+(listinoName?listinoName+" — ":"")+rows.length+" articoli";
  $("confirmPdfImport").classList.toggle("hidden",imported);
  $("cancelPdfImport").classList.toggle("hidden",imported);
  $("pdfPreview").classList.remove("hidden");
}
async function readPdf() {
  const file=$("pdfFile").files[0];if(!file){alert("Seleziona prima un PDF.");return;}
  $("pdfPreview").classList.add("hidden");message("pdfMessage","Lettura del PDF in corso…");
  try{const lines=await extractPdfText(file);pdfPreviewRows=parsePdfLines(lines);
    if(!pdfPreviewRows.length){message("pdfMessage","Nessun articolo riconosciuto. Controlla il PDF e la qualità della scansione.");return;}
    renderPdfPreview(pdfPreviewRows,file.name,false);message("pdfMessage","Controlla l'anteprima prima di importare.");}
  catch(e){message("pdfMessage","Errore PDF: "+e.message);}
}
async function confirmPdfImport() {
  if(!pdfPreviewRows.length)return;
  if(!confirm("Aggiungere questo PDF agli altri listini già caricati? Le selezioni salvate e l’archivio permanente resteranno conservati."))return;
  const file=$("pdfFile").files[0];
  const listinoName=file?file.name:(activeListino&&activeListino.name)||"Listino PDF";
  const rows=pdfPreviewRows.map(a=>({...a}));
  await addPriceList(listinoName,"PDF",rows);
  const n=rows.length;
  renderPdfPreview(rows,listinoName,true);
  $("pdfFile").value="";
  message("pdfMessage",n+" articoli caricati nel nuovo listino. Il listino resta visibile qui sotto.");
}
function cancelPdfImport(){
  pdfPreviewRows=[];
  if(activeListino&&Array.isArray(activeListino.rows))renderPdfPreview(activeListino.rows,activeListino.name,true);
  else $("pdfPreview").classList.add("hidden");
  message("pdfMessage","Importazione annullata.");
}

/* DOCUMENTO */
function escapeHtml(value){return String(value==null?"":value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function optionalMeters(item) {
  const value = String(item && item.quantity != null ? item.quantity : "").trim();
  if (value === "1" && !(item && item.quantitySet === true)) return "";
  return value;
}
function itemOriginalDetails(item) {
  const f = item.originalFields || {};
  const parts = [];
  const add = (label, value) => { const v=String(value==null?"":value).trim(); if(v && !parts.some(x=>norm(x)===norm(label+": "+v))) parts.push(label+": "+v); };
  add("Composizione", f.composition);
  add("Peso", f.weight);
  add("Altezze", f.height);
  if (!f.originalLines && f.fullDescription) add("Dettagli", f.fullDescription);
  // Le colonne aggiuntive dell'Excel vengono riportate con la propria intestazione.
  if (Array.isArray(f.extras)) f.extras.forEach(x => {
    const label=String(x && x.label || "").trim(), value=String(x && x.value || "").trim();
    if(label && value && !["codice","articolo","nome articolo","prezzo"].includes(excelHeaderKey(label))) add(label,value);
  });
  // Usa anche le colonne originali: versioni precedenti potevano salvare
  // i valori grezzi senza popolare extras o soltanto alcuni campi riconosciuti.
  if (Array.isArray(f.columns) && Array.isArray(f.headers)) {
    f.columns.forEach((v,i)=>{
      const label=String(f.headers[i]||"").trim();
      if(label && String(v==null?"":v).trim() &&
         !["codice","codice articolo","articolo","nome articolo","prezzo","prezzo unitario"].includes(excelHeaderKey(label))) {
        add(label,v);
      }
    });
  }
  return parts.join(" · ");
}

function buildDocumentHtml() {
  const c = choicePayload();
  let rows = "";
  const sortedItems=[...c.items].sort((a,b)=>String(a.name||"").localeCompare(String(b.name||""),"it",{sensitivity:"base",numeric:true}));
  const hasMeters = c.items.some(item => !!optionalMeters(item));
  sortedItems.forEach(item => {
    const details = c.includeDetails ? itemOriginalDetails(item) : "";
    const metersCell = hasMeters ? `<td class="meters-strong">${escapeHtml(optionalMeters(item))}</td>` : "";
    rows += `<tr><td><strong>${escapeHtml(item.name)}</strong>${details ? `<br><small>${escapeHtml(details)}</small>` : ""}${item.note ? `<div class="item-note"><b>${t("Nota:")}</b> ${escapeHtml(item.note)}</div>` : ""}</td>${metersCell}${c.includePrices ? `<td>${escapeHtml(priceText(item))}</td>` : ""}</tr>`;
  });
  const title = t("SELEZIONE N.") + " " + (c.number || "—");
  return `<!doctype html><html lang="${currentLanguage}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
  <style>
  body{font-family:Arial,sans-serif;padding:24px;color:#222}h1{color:#174f86;font-size:22px;margin:0 0 18px}
  .meta{line-height:1.55}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border:1px solid #ccc;padding:9px;text-align:left;vertical-align:top}
  th{background:#edf3f8}small{color:#555}.notes{white-space:pre-wrap}.item-note{font-size:1.08rem;font-weight:700;color:#8a3d00;margin-top:7px;white-space:pre-wrap}.meters-strong{font-weight:800;font-size:1.12rem;color:#174f86}
  @media print{body{padding:0}.no-print{display:none!important}}
  </style></head><body>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta"><b>${t("Cliente:")}</b> ${escapeHtml(c.customer)}<br><b>${t("Data:")}</b> ${escapeHtml(c.date)}${c.department ? `<br><b>${t("Reparto:")}</b> ${escapeHtml(c.department)}` : ""}</div>
  ${currentBusinessCardPhoto ? `<div class="business-card"><h3>Biglietto da visita</h3><img src="${currentBusinessCardPhoto}" alt="Biglietto da visita" style="max-width:100%;max-height:230px;object-fit:contain"></div>` : ""}
  <table><thead><tr><th>${t("Articolo")}</th>${hasMeters ? `<th>Metri</th>` : ""}${c.includePrices ? `<th>${t("Prezzo")}</th>` : ""}</tr></thead><tbody>${rows}</tbody></table>
  ${c.note ? `<h3>${t("Note generali")}</h3><p class="notes">${escapeHtml(c.note)}</p>` : ""}
  </body></html>`;
}


async function printDocument() {
  if (!currentItems.length) { alert(t("Aggiungi almeno un articolo.")); return; }
  if (!$("customer").value.trim()) { alert(t("Seleziona prima il cliente.")); $("customer").focus(); return; }
  await ensureSelectionNumber();
  const frame=$("documentPreviewFrame");
  preparedPdfFile=null;
  $("previewPrint").disabled=true;
  $("previewPrint").textContent="Preparazione PDF…";
  frame.srcdoc = buildDocumentHtml();
  $("documentPreviewModal").classList.remove("hidden");
  $("documentPreviewModal").setAttribute("aria-hidden","false");
  try {
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error("Anteprima non pronta")),10000);
      frame.onload=()=>{clearTimeout(timer);resolve();};
    });
    if(!window.html2pdf) throw new Error("Motore PDF non disponibile: verifica la connessione internet e riapri l'app.");
    const sourceDoc=frame.contentDocument;
    if(!sourceDoc || !sourceDoc.body || !sourceDoc.body.innerText.trim()) throw new Error("Il documento dell'anteprima è vuoto.");
    // Attende font e immagini (incluso il biglietto da visita) prima di acquisire il documento.
    if(sourceDoc.fonts && sourceDoc.fonts.ready) await sourceDoc.fonts.ready;
    await Promise.all(Array.from(sourceDoc.images||[]).map(img=>{
      if(img.complete && img.naturalWidth>0) return Promise.resolve();
      return new Promise(resolve=>{img.onload=resolve;img.onerror=resolve;setTimeout(resolve,8000);});
    }));
    // html2pdf acquisisce un nodo del documento principale: clonare il contenuto
    // dell'iframe evita che su iOS venga rasterizzato soltanto il titolo.
    const exportRoot=document.createElement("div");
    exportRoot.style.cssText="position:fixed;left:-12000px;top:0;width:794px;background:#fff;color:#222;z-index:-1;";
    sourceDoc.querySelectorAll("style,link[rel='stylesheet']").forEach(node=>{
      if(node.tagName==="STYLE") exportRoot.appendChild(node.cloneNode(true));
    });
    const exportBody=document.createElement("div");
    exportBody.innerHTML=sourceDoc.body.innerHTML;
    exportBody.style.cssText="width:100%;background:#fff;";
    exportRoot.appendChild(exportBody);
    document.body.appendChild(exportRoot);
    try {
      const worker=html2pdf().set({
        margin:[8,8,8,8],
        filename:"Selezione-"+(choicePayload().number||"documento")+".pdf",
        image:{type:"jpeg",quality:0.96},
        html2canvas:{scale:2,useCORS:true,backgroundColor:"#ffffff",logging:false,windowWidth:794,scrollY:0},
        jsPDF:{unit:"mm",format:"a4",orientation:"portrait"},
        pagebreak:{mode:["css","legacy"]}
      }).from(exportBody).toPdf();
      const pdf=await worker.get("pdf");
      const blob=pdf.output("blob");
      if(!blob || blob.size<1500 || blob.type!=="application/pdf") throw new Error("Il PDF generato è incompleto.");
      const c=choicePayload();
      preparedPdfFile=new File([blob],"Selezione-"+(c.number||"documento")+".pdf",{type:"application/pdf"});
    } finally { exportRoot.remove(); }
    $("previewPrint").textContent="Condividi PDF";
  } catch(e) {
    console.error("Preparazione PDF per condivisione:",e);
    $("previewPrint").textContent="Stampa / Salva PDF";
    message("documentMessage","Non è stato possibile preparare il PDF per la condivisione. Puoi comunque provare la stampa.");
  } finally { $("previewPrint").disabled=false; }
}


async function emailDocument() {
  if (!currentItems.length) { alert(t("Aggiungi almeno un articolo.")); return; }
  if (!$("customer").value.trim()) { alert(t("Seleziona prima il cliente.")); $("customer").focus(); return; }
  await ensureSelectionNumber();
  const c = choicePayload();
  const subject = encodeURIComponent(t("Selezione N. ") + c.number + " - " + c.customer);
  const lines = [...c.items].sort((a,b)=>String(a.name||"").localeCompare(String(b.name||""),"it",{sensitivity:"base",numeric:true})).map(i => {
    const bits = [String(i.name || "").trim()];
    if (c.includeDetails) {
      const details = itemOriginalDetails(i);
      if (details) bits.push(details.trim());
    }
    const meters = optionalMeters(i);
    if (meters) bits.push("METRI: " + meters);
    if (c.includePrices) bits.push(priceText(i));
    if (i.note && i.note.trim()) bits.push("NOTE: " + i.note.trim());
    return bits.filter(Boolean).join("\n");
  });
  const body = encodeURIComponent(
    t("Selezione N. ") + c.number +
    "\n" + t("Cliente:") + " " + c.customer +
    (c.department ? "\n" + t("Reparto:") + " " + c.department : "") +
    "\n" + t("Data:") + " " + c.date + "\n\n" + t("Articoli:") + "\n\n" + lines.join("\n\n") +
    (c.note ? "\n\nNOTE GENERALI:\n" + c.note.trim() : "") +
    "\n\n" + t("Per allegare il PDF, genera il documento e usa Condividi / Salva PDF.")
  );
  const mailto="mailto:?subject=" + subject + "&body=" + body;
  // Usa direttamente il link mailto, evitando la finestra about:blank che rimane aperta al rientro su iOS.
  window.location.href=mailto;
}

async function exportData() {
  const metaRows = await all("meta");
  const selectionSequences = metaRows.filter(x => String(x.key || "").startsWith("selectionSequence-"));
  const payload={exportedAt:new Date().toISOString(),articles:await all("articles"),priceLists:await all("priceLists"),productArchive:await all("productArchive"),choices:await all("choices"),customers:await customersData(),selectionSequences};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download="backup-gestione-listini.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);message("backupMessage","Backup esportato.");
}
async function restoreData() {
  const file=$("restoreFile").files[0];if(!file){alert("Seleziona un file JSON.");return;}
  try{const p=JSON.parse(await file.text());if(Array.isArray(p.articles))await mergeArticles(p.articles);
    if(Array.isArray(p.priceLists)){for(const list of p.priceLists)if(list&&Array.isArray(list.rows))await put("priceLists",{...list,id:list.id||crypto.randomUUID()});}
    else if(Array.isArray(p.articles)&&p.articles.length){await put("priceLists",{id:crypto.randomUUID(),name:"Listino importato dal backup",type:"Backup",rows:p.articles,importedAt:new Date().toISOString()});}
    await put("meta",{key:"priceListsInitialized",value:true});
    if(Array.isArray(p.productArchive))for(const entry of p.productArchive)if(entry.code&&entry.baseName&&entry.variant)await put("productArchive",entry);
    if(Array.isArray(p.choices))for(const c of p.choices)await put("choices",c);
    if(Array.isArray(p.customers))await saveCustomers(p.customers);
    if(Array.isArray(p.selectionSequences))for(const sequence of p.selectionSequences)if(sequence&&String(sequence.key||"").startsWith("selectionSequence-"))await put("meta",sequence);
    await refreshCustomers();await renderSaved();await renderProductArchive();await refreshArticles();await refreshListinoInfo();message("backupMessage","Backup ripristinato. I dati già presenti sono stati conservati.");}
  catch(e){message("backupMessage","Backup non valido: "+e.message);}
}

/* PASSWORD */
async function hashPassword(password,saltHex) {
  const encoder=new TextEncoder(),salt=saltHex?Uint8Array.from(saltHex.match(/.{2}/g),x=>parseInt(x,16)):crypto.getRandomValues(new Uint8Array(16));
  const key=await crypto.subtle.importKey("raw",encoder.encode(password),"PBKDF2",false,["deriveBits"]);
  const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations:150000,hash:"SHA-256"},key,256);
  return {hash:Array.from(new Uint8Array(bits),b=>b.toString(16).padStart(2,"0")).join(""),salt:Array.from(salt,b=>b.toString(16).padStart(2,"0")).join("")};
}
async function createPassword() {
  const first=$("newPassword").value,second=$("confirmPassword").value;
  if(first.length<6){message("authMessage","La password deve contenere almeno 6 caratteri.");return;}
  if(first!==second){message("authMessage","Le password non coincidono.");return;}
  const r=await hashPassword(first);await put("meta",{key:"auth",hash:r.hash,salt:r.salt});
  $("newPassword").value="";$("confirmPassword").value="";await unlockInterface();
}
async function unlockApp() {
  const auth=await getValue("meta","auth");if(!auth)return;
  const r=await hashPassword($("loginPassword").value,auth.salt);
  if(r.hash!==auth.hash){message("authMessage","Password non corretta.");return;}
  $("loginPassword").value="";await unlockInterface();
}
async function unlockInterface() {
  $("authGate").classList.add("hidden");$("appShell").classList.remove("hidden");
  await restoreActiveListino();await refreshArticles();await refreshCustomers();await renderSaved();renderRecentScans();configureIdleLock();
}
function lockApp() {
  if($("appShell").classList.contains("hidden"))return;
  $("appShell").classList.add("hidden");$("authGate").classList.remove("hidden");
  $("passwordSetup").classList.add("hidden");$("passwordLogin").classList.remove("hidden");$("loginPassword").value="";
}
async function changePassword() {
  const auth=await getValue("meta","auth"),old=$("oldPassword").value,next=$("newPasswordChange").value;
  if(!auth||next.length<6){message("settingsMessage","La nuova password deve avere almeno 6 caratteri.");return;}
  const oldHash=await hashPassword(old,auth.salt);if(oldHash.hash!==auth.hash){message("settingsMessage","Password attuale non corretta.");return;}
  const r=await hashPassword(next);await put("meta",{key:"auth",hash:r.hash,salt:r.salt});
  $("oldPassword").value="";$("newPasswordChange").value="";message("settingsMessage","Password aggiornata.");
}

/* IMPOSTAZIONI */
async function configureIdleLock() {
  if(idleTimer)clearTimeout(idleTimer);
  const setting=await getValue("meta","idleLock"),minutes=setting?Number(setting.value):0;
  if(!minutes)return;
  idleTimer=setTimeout(()=>{if(scanner)stopScanner();lockApp();},minutes*60*1000);
}
async function saveSettings() {
  await put("meta",{key:"idleLock",value:Number($("idleLock").value)});
  await put("meta",{key:"rememberLogin",value:$("rememberLogin").value});
  await configureIdleLock();message("settingsMessage","Impostazioni salvate.");
}
async function loadSettings() {
  const setting=await getValue("meta","idleLock");if(setting)$("idleLock").value=String(setting.value);
  const remember=await getValue("meta","rememberLogin");if(remember)$("rememberLogin").value=remember.value;
  const language=await getValue("meta","language");if(language){currentLanguage=language.value;$("language").value=currentLanguage;}
}

const EN = {
  "Gestione Listini 2.0":"Price List Manager 2.0",
  "Archivio e gestione offerte":"Selections and document manager",
  "Lingua":"Language",
  "Italiano":"Italian",
  "English":"English",
  "Connesso — dati conservati sul dispositivo":"Online — data stored on this device",
  "Offline — puoi utilizzare i dati già salvati":"Offline — saved data remains available",
  "1. Scegli cliente":"1. Choose customer",
  "Cliente e reparto":"Customer and department",
  "Cliente":"Customer",
  "Seleziona o inserisci il cliente":"Select or enter a customer",
  "Reparto (facoltativo)":"Department (optional)",
  "Nessun reparto / seleziona":"No department / select",
  "Nuovo reparto":"New department",
  "Nome reparto":"Department name",
  "Aggiungi reparto al cliente":"Add department to customer",
  "2. Cerca e aggiungi articoli":"2. Find and add items",
  "Ricerca e scansione articoli":"Item search and scanning",
  "Cerca per nome o codice":"Search by name or code",
  "Scrivi il nome o il codice articolo":"Enter item name or code",
  "Apri fotocamera e scansiona":"Open camera and scan",
  "Chiudi scanner":"Close scanner",
  "Usa la fotocamera posteriore. Tieni il codice EAN orizzontale, a fuoco e ben illuminato.":"Use the rear camera. Keep the EAN barcode horizontal, in focus and well lit.",
  "Scanner non avviato.":"Scanner not started.",
  "3. Controlla la selezione":"3. Review selection",
  "Scelta articoli":"Selected items",
  "Data":"Date",
  "Numero selezione (assegnato automaticamente)":"Selection number (assigned automatically)",
  "Automatico":"Automatic",
  "Articoli selezionati":"Selected items",
  "Nessun articolo selezionato.":"No items selected.",
  "Inserimento articolo manuale":"Add item manually",
  "L'articolo sarà inserito solo in questa scelta e non nel listino.":"This item will be added only to this selection, not to the price list.",
  "Nome articolo":"Item name",
  "Prezzo":"Price",
  "Quantità / metraggio":"Quantity / length",
  "Nota articolo":"Item note",
  "Aggiungi articolo manuale":"Add manual item",
  "Inserisci articolo non presente nel listino":"Add an item not in the price list",
  "Note generali della scelta":"Selection notes",
  "Note aggiuntive...":"Additional notes...",
  "4. Salva e crea documento":"4. Save and create document",
  "Documento finale":"Final document",
  "Tipo documento":"Document type",
  "Riepilogo semplice":"Simple summary",
  "Offerta commerciale":"Commercial offer",
  "Includi i prezzi nel documento e nell'email":"Include prices in the document and email",
  "Includi i dettagli originali degli articoli disponibili":"Include available original item details",
  "Condizioni commerciali":"Commercial terms",
  "Tempi, validità offerta, pagamento, consegna...":"Timing, offer validity, payment, delivery...",
  "Salva scelta":"Save selection",
  "Nuova scelta":"New selection",
  "Genera PDF / Stampa":"Create PDF / Print",
  "Prepara email":"Prepare email",
  "Archivio selezioni salvate":"Saved selections",
  "Cerca per cliente o numero selezione":"Search by customer or selection number",
  "Es. Rossi oppure 12/2026":"E.g. Smith or 12/2026",
  "Listini e importazione articoli":"Price lists and item import",
  "Importazione listino":"Import price list",
  "Importa il listino PDF, CSV oppure Excel. Gli articoli importati vengono conservati nell'archivio locale.":"Import a PDF, CSV or Excel price list. Imported items are stored locally.",
  "Listino PDF":"PDF price list",
  "Leggi PDF e mostra anteprima":"Read PDF and show preview",
  "Seleziona un PDF.":"Select a PDF.",
  "Articoli riconosciuti":"Recognized items",
  "Conferma importazione":"Confirm import",
  "Annulla":"Cancel",
  "Listino CSV":"CSV price list",
  "Importa CSV":"Import CSV",
  "Listino Excel":"Excel price list",
  "Importa Excel":"Import Excel",
  "Nessun listino caricato.":"No price list loaded.",
  "Backup e ripristino":"Backup and restore",
  "Esporta una copia dei dati o ripristina un backup precedente. Questa sezione è separata dalla gestione della password.":"Export a copy of your data or restore a previous backup. This section is separate from password management.",
  "Esporta backup JSON":"Export JSON backup",
  "File di backup":"Backup file",
  "Ripristina backup":"Restore backup",
  "Gestione password e sicurezza":"Password and security",
  "Richiedi password a ogni apertura":"Require password every time the app opens",
  "Sì, chiedi sempre la password":"Yes, always ask for password",
  "No, mantieni l'accesso su questo dispositivo":"No, keep me signed in on this device",
  "Se scegli di mantenere l'accesso, chiunque apra l'app su questo dispositivo potrà vedere i dati finché non la blocchi manualmente o interviene il blocco per inattività.":"If you stay signed in, anyone opening the app on this device can see its data until you lock it or the inactivity lock activates.",
  "Blocco automatico dell'app per inattività":"Automatically lock the app after inactivity",
  "Disattivato":"Disabled",
  "5 minuti":"5 minutes",
  "10 minuti":"10 minutes",
  "15 minuti":"15 minutes",
  "30 minuti":"30 minutes",
  "Salva impostazioni":"Save settings",
  "Cambia password":"Change password",
  "Password attuale":"Current password",
  "Nuova password":"New password",
  "Blocca applicazione adesso":"Lock app now",
  "I dati vengono conservati nel browser del dispositivo. Effettua regolarmente un backup JSON. Il blocco con password protegge l'accesso all'interfaccia; non equivale alla cifratura dell'archivio. La funzione di blocco dell'app è distinta dallo spegnimento automatico dello schermo dell'iPhone.":"Data is stored in this device's browser. Export JSON backups regularly. The password protects access to the interface; it does not encrypt the archive. App locking is separate from the iPhone's automatic screen lock.",
  "Anteprima selezione":"Selection preview",
  "Condividi / Salva PDF":"Share / Save PDF",
  "Torna all'app":"Back to app",
  "Su iPhone, nella schermata di stampa usa il pulsante di condivisione per inviare o salvare il PDF.":"On iPhone, use the share button in the print screen to send or save the PDF.",
  "Aggiungi alla scelta":"Add to selection",
  "Codice":"Code",
  "Quantità:":"Quantity:",
  "Nota:":"Note:",
  "Prezzo non indicato":"Price not specified",
  "Nessun articolo trovato.":"No items found.",
  "Nessuna scelta salvata.":"No saved selections.",
  "Nessuna selezione corrispondente.":"No matching selections.",
  "Apri selezione":"Open selection",
  "Elimina selezione":"Delete selection",
  "Selezione":"Selection",
  "Senza cliente":"No customer",
  "articoli":"items",
  "Aggiungi almeno un articolo.":"Add at least one item.",
  "Seleziona prima il cliente.":"Select a customer first.",
  "Aggiungi almeno un articolo prima di salvare.":"Add at least one item before saving.",
  "Inserisci prima il cliente.":"Enter the customer first.",
  "Scrivi il nome del reparto.":"Enter the department name.",
  "Cliente e reparto salvati.":"Customer and department saved.",
  "Seleziona o inserisci il cliente prima di aggiungere articoli.":"Select or enter a customer before adding items.",
  "Cliente selezionato. Reparto facoltativo.":"Customer selected. Department is optional.",
  "Cliente e reparto selezionati.":"Customer and department selected.",
  "Scelta salvata sul dispositivo.":"Selection saved on this device.",
  "Selezione eliminata. Il numero progressivo non verrà riutilizzato.":"Selection deleted. Its sequence number will not be reused.",
  "Selezione salvata. Inserisci il prossimo cliente.":"Selection saved. Enter the next customer.",
  "Accesso protetto all'archivio locale.":"Secure access to the local archive.",
  "Crea la password":"Create password",
  "Conferma password":"Confirm password",
  "Crea password":"Create password",
  "Accedi":"Sign in",
  "Archivio e gestione offerte":"Selections and document manager",
  "Controllo connessione…":"Checking connection…",
  "Nuovo reparto":"New department",
  "Aggiungi reparto al cliente":"Add department to customer",
  "Condizioni commerciali":"Commercial terms",
  "Tempi, validità offerta, pagamento, consegna...":"Timing, offer validity, payment, delivery...",
  "Rimuovi":"Remove",
  "Cancella":"Delete",
  "Ultimi 3 articoli scansionati":"Last 3 scanned items",
  "Nota articolo":"Item note",
  "Quantità / metri":"Quantity / length",
  "Prezzo non indicato":"Price not specified",
  "Scanner già attivo.":"Scanner already active.",
  "Scanner fermato.":"Scanner stopped.",
  "Fotocamera attiva. Inquadra il codice EAN in orizzontale, con buona luce.":"Camera active. Frame the EAN barcode horizontally in good light.",
  "Codice non trovato. Inserisci manualmente l'articolo.":"Code not found. Enter the item manually.",
  "Seleziona o inserisci il cliente prima di aggiungere articoli.":"Select or enter a customer before adding items.",
  "Articolo già presente nella scelta: ":"Item already in selection: ",
  "Selezione salvata sul dispositivo.":"Selection saved on this device.",
  "Impossibile aprire la stampa su questo browser.":"Unable to open printing on this browser.",
  "Importa il listino PDF, CSV oppure Excel. Gli articoli importati vengono conservati nell'archivio locale.":"Import a PDF, CSV or Excel price list. Imported items are stored locally.",
  "Esporta una copia dei dati o ripristina un backup precedente. Questa sezione è separata dalla gestione della password.":"Export a copy of your data or restore a previous backup. This section is separate from password management.",
  "Password":"Password",
  "Codice ":"Code ",
  "articoli caricati nel nuovo listino.":"items imported or updated.",
  "articoli riconosciuti":"recognized items",
  "articoli salvati sul dispositivo.":"items stored on this device.",
  "Controlla l'anteprima prima di importare.":"Review the preview before importing.",
  "Importazione annullata.":"Import cancelled.",
  "Impossibile caricare il motore OCR.":"Unable to load the OCR engine.",
  "Inserisci il nome dell'articolo.":"Enter the item name.",
  "La fotocamera richiede una pagina HTTPS.":"The camera requires an HTTPS page.",
  "Lettore Excel non disponibile. Apri l'app online una volta.":"Excel reader unavailable. Open the app online once.",
  "Lettore PDF non disponibile.":"PDF reader unavailable.",
  "Lettura del PDF in corso…":"Reading PDF…",
  "Nessun articolo riconosciuto.":"No items recognized.",
  "Nessun articolo riconosciuto. Controlla il PDF e la qualità della scansione.":"No items recognized. Check the PDF and scan quality.",
  "Seleziona prima un PDF.":"Select a PDF first.",
  "Seleziona un file CSV.":"Select a CSV file.",
  "Seleziona un file Excel.":"Select an Excel file.",
  "Scanner attivo: mantieni il codice intero nell'inquadratura, orizzontale e a fuoco. Avvicina o allontana lentamente il telefono.":"Scanner active: keep the full barcode in frame, horizontal and in focus. Slowly move the phone closer or farther away.",
  "Selezione N.":"Selection No.",
  "items":"items",
  "articoli":"items",
  "Ultimi 3 articoli scansionati":"Last 3 scanned items",
  "Interfaccia italiana selezionata.":"Italian interface selected.",
  "English interface selected.":"English interface selected.",
  "Inserisci prima il cliente.":"Enter the customer first.",
  "Articolo già presente nella scelta: ":"Item already in selection: ",
  "Codice non trovato. Inserisci manualmente l'articolo.":"Code not found. Enter the item manually.",
  "accesso non disponibile":"access unavailable",
  "Backup esportato.":"Backup exported.",
  "Backup ripristinato. I dati già presenti sono stati conservati.":"Backup restored. Existing data has been preserved.",
  "Backup non valido: ":"Invalid backup: ",
  "La password deve contenere almeno 6 caratteri.":"Password must contain at least 6 characters.",
  "Le password non coincidono.":"Passwords do not match.",
  "Password non corretta.":"Incorrect password.",
  "La nuova password deve avere almeno 6 caratteri.":"The new password must contain at least 6 characters.",
  "Password attuale non corretta.":"Current password is incorrect.",
  "Password aggiornata.":"Password updated.",
  "Impostazioni salvate.":"Settings saved.",
  "articoli caricati nel nuovo listino.":"items imported or updated.",
  "Errore inizializzazione archivio: ":"Archive initialization error: ",
  "Errore fotocamera: ":"Camera error: ",
  "Errore CSV: ":"CSV error: ",
  "Errore Excel: ":"Excel error: ",
  "Errore PDF: ":"PDF error: ",
  "Selezione ":"Selection ",
  " · ":" · ",
  " articoli salvati sul dispositivo.":" items stored on this device.",
  " salvata. Inserisci il prossimo cliente.":" saved. Enter the next customer.",
  "SELEZIONE N.":"SELECTION NO.",
  "Cliente:":"Customer:",
  "Data:":"Date:",
  "Reparto:":"Department:",
  "Articolo":"Item",
  "Quantità":"Quantity",
  "Note generali":"General notes",
  "Nota:":"Note:",
  "Prezzo":"Price",
  "Selezione N. ":"Selection No. ",
  "Articoli:":"Items:",
  "Per allegare il PDF, genera il documento e usa Condividi / Salva PDF.":"To attach the PDF, create it and use Share / Save PDF.",
  "Quantità:":"Quantity:",
  "Articoli:":"Items:",
};
function t(value) {
  if (currentLanguage !== "en") return value;
  if (EN[value]) return EN[value];
  const prefixes = [
    ["TROVATO: ", "FOUND: "],
    ["GIÀ PRESENTE: ", "ALREADY IN SELECTION: "],
    ["Errore fotocamera: ", "Camera error: "],
    ["Errore CSV: ", "CSV error: "],
    ["Errore Excel: ", "Excel error: "],
    ["Errore PDF: ", "PDF error: "],
    ["Lettura pagina ", "Reading page "],
    ["Importare o aggiornare ", "Import or update "],
    ["Codice ", "Code "],
    ["Selezione ", "Selection "],
    ["Articolo già presente nella scelta: ", "Item already in selection: "],
    ["n articoli", "n items"]
  ];
  for (const [from,to] of prefixes) if (String(value).startsWith(from)) return to + String(value).slice(from.length);
  const suffixes = [
    [" articoli salvati sul dispositivo.", " items stored on this device."],
    [" articoli caricati nel nuovo listino.", " items imported or updated."],
    [" salvata. Inserisci il prossimo cliente.", " saved. Enter the next customer."]
  ];
  for (const [from,to] of suffixes) if (String(value).endsWith(from)) return String(value).slice(0,-from.length) + to;
  return value;
}
function applyLanguage() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!node.__italianText) node.__italianText = node.nodeValue;
    const original = node.__italianText;
    const trimmed = original.trim();
    if (!trimmed) continue;
    const translated = currentLanguage === "en" ? (EN[trimmed] || trimmed) : trimmed;
    const leading = original.match(/^\s*/)?.[0] || "";
    const trailing = original.match(/\s*$/)?.[0] || "";
    node.nodeValue = leading + translated + trailing;
  }
  const placeholders = {
    "Seleziona o inserisci il cliente":"Select or enter a customer",
    "Nome reparto":"Department name",
    "Scrivi il nome o il codice articolo":"Enter item name or code",
    "Automatico":"Automatic",
    "Note aggiuntive...":"Additional notes...",
    "Tempi, validità offerta, pagamento, consegna...":"Timing, offer validity, payment, delivery...",
    "Es. Rossi oppure 12/2026":"E.g. Smith or 12/2026"
  };
  document.querySelectorAll("[placeholder]").forEach(el => {
    if (!el.__italianPlaceholder) el.__italianPlaceholder = el.getAttribute("placeholder");
    const original = el.__italianPlaceholder;
    el.setAttribute("placeholder", currentLanguage === "en" ? (placeholders[original] || original) : original);
  });
}

async function saveLanguage() {
  currentLanguage = $("language").value;
  await put("meta", {key:"language",value:currentLanguage});
  applyLanguage();
  message("settingsMessage", currentLanguage === "en" ? "English interface selected." : "Interfaccia italiana selezionata.");
}



/* EVENTI E AVVIO */
$("createPassword").onclick=createPassword;$("unlockApp").onclick=unlockApp;
$("addDepartment").onclick=saveCustomerDepartment;
$("customer").onchange=async()=>{await refreshDepartments();await renderCustomerMatches();await loadCustomerBusinessCard();if($("customer").value.trim())message("customerMessage","Controlla i clienti già presenti nell'elenco, se compaiono.");};
$("customer").oninput=async()=>{await refreshDepartments();await renderCustomerMatches();await loadCustomerBusinessCard();};
$("customer").onfocus=renderCustomerMatches;
$("businessCardPhoto").onchange=async()=>{
  const file=$("businessCardPhoto").files[0];if(!file)return;
  if(!file.type.startsWith("image/")){alert("Seleziona un'immagine.");return;}
  const reader=new FileReader();reader.onload=async()=>{
    currentBusinessCardPhoto=String(reader.result||"");
    const name=$("customer").value.trim();
    if(name){const data=await customersData();let c=data.find(x=>norm(x.name)===norm(name));if(!c){c={name,departments:[]};data.push(c);}c.businessCardPhoto=currentBusinessCardPhoto;await saveCustomers(data);}
    $("businessCardStatus").textContent="Foto del biglietto salvata per il cliente.";
    $("deleteBusinessCardPhoto").classList.toggle("hidden",!currentBusinessCardPhoto);
  };reader.readAsDataURL(file);
};
$("deleteBusinessCardPhoto").onclick=async()=>{
  const name=$("customer").value.trim();
  if(!currentBusinessCardPhoto)return;
  if(!confirm("Eliminare la foto del biglietto da visita salvata per questo cliente?"))return;
  const data=await customersData();const customer=data.find(c=>norm(c.name)===norm(name));
  if(customer){delete customer.businessCardPhoto;await saveCustomers(data);}
  currentBusinessCardPhoto="";$("businessCardPhoto").value="";
  $("businessCardStatus").textContent="Nessuna foto del biglietto salvata.";
  $("deleteBusinessCardPhoto").classList.add("hidden");
};
document.addEventListener("click", event => {
  const matches = $("customerMatches");
  if (matches && !matches.contains(event.target) && event.target !== $("customer")) matches.classList.add("hidden");
});
$("search").oninput=renderResults;$("startScan").onclick=startScanner;
$("toggleBluetoothScanner").onclick=()=>{
  bluetoothScannerEnabled=!bluetoothScannerEnabled;
  $("bluetoothScannerInput").classList.toggle("hidden",!bluetoothScannerEnabled);
  $("toggleBluetoothScanner").textContent=bluetoothScannerEnabled?"Disattiva scanner Bluetooth":"Usa scanner Bluetooth";
  if(bluetoothScannerEnabled){$("bluetoothScannerInput").focus();message("scanMessage","Scanner Bluetooth attivo: collega il lettore e scansisci il codice.");}
  else message("scanMessage","Scanner Bluetooth disattivato.");
};
$("bluetoothScannerInput").addEventListener("keydown",async e=>{
  if(e.key==="Enter"){e.preventDefault();const code=$("bluetoothScannerInput").value.trim();$("bluetoothScannerInput").value="";if(code)await onBarcode(code);}
});
$("addProductArchiveEntry").onclick=addProductArchiveEntry;
$("archiveUnknownCode").onclick=()=>{
  $("archiveCode").value=lastUnknownCode||"";
  $("productArchiveWorkspace").classList.remove("hidden");
  const moreTab=document.querySelector('.nav-tab[data-tab="more"]');if(moreTab)moreTab.click();
  renderProductArchive();
  $("archiveBaseName").focus();
};
$("showProductArchive").onclick=async()=>{ $("productArchiveWorkspace").classList.toggle("hidden"); await renderProductArchive(); };
$("showManual").onclick=async()=>{if(await ensureCustomer())$("manualAdd").classList.remove("hidden");};
$("addManual").onclick=addManual;
$("readPdf").onclick=readPdf;$("confirmPdfImport").onclick=confirmPdfImport;$("cancelPdfImport").onclick=cancelPdfImport;
$("importCsv").onclick=importCsv;$("importExcel").onclick=importExcel;$("csvFile").onchange=()=>showSelectedImportFile("csvFile","csvSelectedName","Nessun file CSV selezionato.");$("excelFile").onchange=()=>showSelectedImportFile("excelFile","excelSelectedName","Nessun file Excel selezionato.");
$("saveChoice").onclick=saveChoice;$("newChoice").onclick=newChoice;$("printDocument").onclick=printDocument;$("emailDocument").onclick=emailDocument;
$("savedSearch").oninput=renderSaved;
$("previewClose").onclick=()=>{$("documentPreviewModal").classList.add("hidden");$("documentPreviewModal").setAttribute("aria-hidden","true");};
$("previewPrint").onclick=async()=>{
  try{
    if(preparedPdfFile && navigator.canShare && navigator.canShare({files:[preparedPdfFile]}) && navigator.share){
      await navigator.share({files:[preparedPdfFile],title:preparedPdfFile.name});
      return;
    }
    if(preparedPdfFile){
      const url=URL.createObjectURL(preparedPdfFile);
      const a=document.createElement("a");a.href=url;a.download=preparedPdfFile.name;a.rel="noopener";document.body.appendChild(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),60000);
      message("documentMessage","Il PDF è stato preparato. Se la condivisione diretta non è supportata, il file viene salvato per poterlo allegare.");
      return;
    }
    const frame=$("documentPreviewFrame");
    if(!frame.contentWindow)throw new Error("Anteprima non disponibile");
    frame.contentWindow.focus();frame.contentWindow.print();
  }catch(e){
    if(e && e.name==="AbortError")return;
    console.error("Condivisione PDF:",e);
    message("documentMessage","Condivisione non riuscita. Riprova oppure usa Stampa / Salva PDF.");
  }
};
$("exportData").onclick=exportData;$("restoreData").onclick=restoreData;
$("clearRestoreFile").onclick=()=>{if(!$("restoreFile").files.length)return;if(confirm("Rimuovere il backup selezionato dal modulo? Il file originale sul dispositivo non verrà cancellato.")){$("restoreFile").value="";$("restoreFileName").textContent="Nessun backup selezionato.";}}; 
$("restoreFile").onchange=()=>{$("restoreFileName").textContent=$("restoreFile").files[0]?"Backup selezionato: "+$("restoreFile").files[0].name:"Nessun backup selezionato.";};
$("saveSettings").onclick=saveSettings;$("changePassword").onclick=changePassword;$("lockApp").onclick=lockApp;$("language").onchange=saveLanguage;
window.addEventListener("online",status);window.addEventListener("offline",status);
["click","keydown","touchstart","mousemove"].forEach(eventName=>document.addEventListener(eventName,()=>{
  if(!$("appShell").classList.contains("hidden"))configureIdleLock();
},{passive:true}));
document.addEventListener("visibilitychange",async()=>{if(document.visibilityState==="visible"&&scanner&&"wakeLock"in navigator)await requestScreenWakeLock();});
(async function init(){
  try{
    db=await openDb();status();await loadSettings();applyLanguage();
    const auth=await getValue("meta","auth");
    if(auth){
      const remember=await getValue("meta","rememberLogin");
      if(remember&&remember.value==="no"){await unlockInterface();}
      else{$("authGate").classList.remove("hidden");$("passwordLogin").classList.remove("hidden");}
    }else{$("authGate").classList.remove("hidden");$("passwordSetup").classList.remove("hidden");}
    newChoice();
    if("serviceWorker"in navigator){try{await navigator.serviceWorker.register("./sw.js?v=18");}catch(e){console.warn("Service worker non registrato",e);}}
  }catch(e){alert("Errore inizializzazione archivio: "+e.message);}
})();
