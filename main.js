const { app, BrowserWindow, WebContentsView, ipcMain, Menu, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');

app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|ai-multi-chat)\/\S+/g, '');

const SB_OPEN = 200, SB_SHUT = 48, PAD = 8, HDR = 34, INPUT = 104;
const LAYOUTS = [[1, 1], [2, 1], [3, 1], [2, 2], [3, 2], [4, 2], [3, 3]]; // [列, 行]
const platforms = JSON.parse(fs.readFileSync(path.join(__dirname, 'platforms.json'), 'utf8'));
const dataFile = n => path.join(app.getPath('userData'), n);
const readJson = (n, d) => { try { return JSON.parse(fs.readFileSync(dataFile(n), 'utf8')); } catch (e) { return d; } };
const writeJson = (n, v) => { try { fs.writeFileSync(dataFile(n), JSON.stringify(v, null, 1)); } catch (e) {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let settings = { selected: platforms.slice(0, 4).map(p => p.id), layout: 3, zoom: 0.8, sidebar: true, models: {}, ...readJson('settings.json', {}) };
if (!LAYOUTS[settings.layout]) settings.layout = 3;
const save = () => writeJson('settings.json', settings);
const cap = () => LAYOUTS[settings.layout][0] * LAYOUTS[settings.layout][1];
const byId = id => platforms.find(p => p.id === id);
const visible = () => platforms.filter(p => settings.selected.includes(p.id)).slice(0, cap());

let win, loaded = false;
const views = {}, attached = new Set();

function ensureView(p) {
  if (views[p.id]) return views[p.id];
  const v = new WebContentsView({ webPreferences: { partition: 'persist:' + p.id, contextIsolation: true, sandbox: true } });
  const wc = v.webContents;
  wc.setWindowOpenHandler(({ url }) => { wc.loadURL(url); return { action: 'deny' }; });
  wc.on('dom-ready', () => wc.setZoomFactor(settings.zoom));
  wc.on('before-input-event', (e, i) => { if (i.type === 'keyDown' && i.control && i.shift && i.key.toLowerCase() === 'i') wc.toggleDevTools(); });
  wc.loadURL(p.url);
  return (views[p.id] = v);
}

function layout() {
  if (!win) return;
  const [W, H] = win.getContentSize();
  const SB = settings.sidebar ? SB_OPEN : SB_SHUT;
  const [cols, rows] = LAYOUTS[settings.layout];
  const x0 = SB + PAD, y0 = PAD, x1 = W - PAD, y1 = H - INPUT - 2 * PAD;
  const cw = Math.floor((x1 - x0 - (cols - 1) * PAD) / cols), ch = Math.floor((y1 - y0 - (rows - 1) * PAD) / rows);
  const cells = [];
  for (let i = 0; i < cols * rows; i++) cells.push({ x: x0 + (i % cols) * (cw + PAD), y: y0 + Math.floor(i / cols) * (ch + PAD), w: cw, h: ch });
  const vis = visible();
  for (const p of platforms) {
    if (!vis.includes(p) && attached.has(p.id)) { win.contentView.removeChildView(views[p.id]); attached.delete(p.id); }
  }
  vis.forEach((p, i) => {
    const v = ensureView(p);
    if (!attached.has(p.id)) { win.contentView.addChildView(v); attached.add(p.id); }
    const c = cells[i];
    v.setBounds({ x: c.x, y: c.y + HDR, width: c.w, height: c.h - HDR });
    v.webContents.setZoomFactor(settings.zoom);
  });
  if (loaded) win.webContents.send('state', {
    platforms: platforms.map(({ id, name, color }) => ({ id, name, color })),
    selected: settings.selected, visible: vis.map(p => p.id), layout: settings.layout, layouts: LAYOUTS,
    zoom: settings.zoom, sidebar: settings.sidebar, models: settings.models, cells, HDR, SB,
    input: { x: x0, y: H - INPUT - PAD, w: x1 - x0, h: INPUT }
  });
}
const toast = m => win && win.webContents.send('toast', m);

// ---------- 在网页内执行的函数（必须自包含） ----------
const runPage = (wc, fn, ...args) => wc.executeJavaScript(`(${fn.toString()})(${args.map(a => JSON.stringify(a)).join(',')})`, true);

// 定位输入框：配置选择器优先，否则取页面上面积最大的可编辑元素；并打上标记供后续读写
function pageLocate(inputSels) {
  const vis = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 20 && r.height > 10 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const list = s => { try { return [...document.querySelectorAll(s)].filter(vis); } catch (e) { return []; } };
  let el = null;
  for (const s of inputSels) { const l = list(s); if (l.length) { el = l[l.length - 1]; break; } }
  if (!el) {
    const l = list('textarea,[contenteditable="true"],[contenteditable=""],[role="textbox"]');
    l.sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return rb.width * rb.height - ra.width * ra.height; });
    el = l[0] || null;
  }
  if (!el) return { ok: false, msg: '未找到输入框（可能未登录，或需更新 platforms.json）' };
  document.querySelectorAll('[data-ai-target]').forEach(n => n.removeAttribute('data-ai-target'));
  el.setAttribute('data-ai-target', '1');
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  const cn = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
  return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2, info: el.tagName.toLowerCase() + (cn ? '.' + cn : '') };
}
function pageRead() {
  const e = document.querySelector('[data-ai-target]');
  if (!e) return '';
  return (e.tagName === 'TEXTAREA' || e.tagName === 'INPUT') ? e.value : (e.innerText || e.textContent || '');
}
function pageFill(text) { // 备用方式：直接改页面内容
  const el = document.querySelector('[data-ai-target]');
  if (!el) return false;
  el.focus();
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else { document.execCommand('selectAll', false, null); document.execCommand('insertText', false, text); }
  return true;
}
function pageFindSend(sendSels) { // 找可点击的发送按钮：配置选择器优先，其次在输入框附近按名称猜
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4 && getComputedStyle(e).visibility !== 'hidden'; };
  const ok = b => vis(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
  let found = null;
  for (const s of sendSels) { try { const l = [...document.querySelectorAll(s)].filter(ok); if (l.length) { found = l[l.length - 1]; break; } } catch (e) {} }
  if (!found) {
    let c = document.querySelector('[data-ai-target]');
    for (let i = 0; i < 6 && c && !found; i++) {
      c = c.parentElement; if (!c) break;
      found = [...c.querySelectorAll('button,[role="button"]')].filter(ok).find(b =>
        /send|发送|提交|submit/i.test((b.getAttribute('aria-label') || '') + (b.title || '') + (typeof b.className === 'string' ? b.className : '') + (b.getAttribute('data-testid') || '')));
    }
  }
  if (!found) return null;
  const r = found.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

async function pageModel(trigger, name) { // name 为空 = 只打开官网菜单
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4 && getComputedStyle(e).visibility !== 'hidden'; };
  const press = e => ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(t => e.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
  let tr = null;
  if (trigger) { try { tr = [...document.querySelectorAll(trigger)].find(vis); } catch (e) {} }
  if (!tr) tr = [...document.querySelectorAll('[aria-haspopup="menu"],[aria-haspopup="listbox"]')].find(vis);
  if (!tr) return { ok: false, msg: '未找到模型菜单入口，请在页面里手动选择（可在 platforms.json 填 modelTrigger）' };
  press(tr);
  if (!name) return { ok: true };
  await sleep(600);
  const items = [...document.querySelectorAll('[role="menuitem"],[role="option"],[role="menuitemradio"],li,button,div')]
    .filter(e => vis(e) && e !== tr && (e.textContent || '').includes(name))
    .sort((a, b) => a.textContent.length - b.textContent.length);
  if (!items.length) return { ok: false, msg: '菜单里没找到「' + name + '」，请手动选择' };
  press(items[0]);
  return { ok: true };
}

function pageAnswer(sels) {
  for (const s of [...sels, '[class*="markdown"]']) {
    let l = []; try { l = [...document.querySelectorAll(s)].filter(e => e.innerText && e.innerText.trim()); } catch (e) {}
    if (l.length) return { ok: true, text: l[l.length - 1].innerText.trim() };
  }
  return { ok: false, msg: '未找到回答内容（可在 platforms.json 填 answer 选择器）' };
}

// ---------- 真实输入（模拟鼠标键盘）+ 校验 ----------
const nrm = s => (s || '').replace(/\s+/g, '');
async function realClick(wc, cx, cy) {
  const z = wc.getZoomFactor(), x = Math.round(cx * z), y = Math.round(cy * z);
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}
function pressKey(wc, key, mods = []) {
  wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: mods });
  if (key === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: 'Enter', modifiers: mods });
  wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods });
}

async function injectOne(p, text) {
  const wc = views[p.id].webContents, snip = nrm(text).slice(0, 20);
  const fail = msg => ({ name: p.name, ok: false, msg });
  try {
    const loc = await runPage(wc, pageLocate, p.input || []);
    if (!loc.ok) return fail(loc.msg);
    wc.focus(); await sleep(100);
    await realClick(wc, loc.x, loc.y); await sleep(150);
    pressKey(wc, 'A', ['control']); await sleep(80);
    await wc.insertText(text); await sleep(350);
    let cur = await runPage(wc, pageRead);
    if (!nrm(cur).includes(snip)) {
      await runPage(wc, pageFill, text); await sleep(400);
      cur = await runPage(wc, pageRead);
      if (!nrm(cur).includes(snip)) return fail('文字未能写入输入框（命中元素 ' + loc.info + '）');
    }
    const sr = await runPage(wc, pageFindSend, p.send || []);
    if (sr) await realClick(wc, sr.x, sr.y); else pressKey(wc, 'Enter');
    await sleep(900);
    cur = await runPage(wc, pageRead);
    if (nrm(cur).includes(snip)) { // 没发出去：换另一种方式再试一次
      if (sr) pressKey(wc, 'Enter');
      else { const sr2 = await runPage(wc, pageFindSend, []); if (sr2) await realClick(wc, sr2.x, sr2.y); }
      await sleep(900);
      cur = await runPage(wc, pageRead);
      if (nrm(cur).includes(snip)) return fail('已填入但未发出，请手动点发送（元素 ' + loc.info + '）');
    }
    return { name: p.name, ok: true, msg: '' };
  } catch (e) { return fail(String(e.message || e)); }
}

// ---------- IPC ----------
const h = (n, fn) => ipcMain.handle(n, (_e, ...a) => fn(...a));
h('ready', () => { loaded = true; layout(); });
h('toggle', id => {
  const i = settings.selected.indexOf(id);
  if (i >= 0) settings.selected.splice(i, 1);
  else {
    settings.selected.push(id);
    const n = settings.selected.length;
    if (n > cap()) { const k = LAYOUTS.findIndex(l => l[0] * l[1] >= n); settings.layout = k < 0 ? LAYOUTS.length - 1 : k; }
  }
  save(); layout();
});
h('setLayout', i => { settings.layout = i; save(); layout(); });
h('setZoom', z => { settings.zoom = z; save(); layout(); });
h('toggleSidebar', () => { settings.sidebar = !settings.sidebar; save(); layout(); });
h('refresh', id => views[id] && views[id].webContents.reload());
h('newChat', id => views[id] && views[id].webContents.loadURL(byId(id).url));
h('newChatAll', () => { for (const id of attached) views[id].webContents.loadURL(byId(id).url); });

h('modelMenu', id => {
  const p = byId(id), wc = views[id].webContents;
  const run = async name => { const r = await runPage(wc, pageModel, p.modelTrigger || '', name).catch(e => ({ ok: false, msg: String(e) })); if (!r.ok) toast(p.name + '：' + r.msg); };
  const tpl = (p.models || []).map(name => ({ label: name, type: 'radio', checked: settings.models[id] === name,
    click: () => { settings.models[id] = name; save(); layout(); run(name); } }));
  if (tpl.length) tpl.push({ type: 'separator' });
  tpl.push({ label: '默认模型（不切换）', click: () => { delete settings.models[id]; save(); layout(); } });
  tpl.push({ label: '打开官网模型菜单（手动选）', click: () => run('') });
  Menu.buildFromTemplate(tpl).popup({ window: win });
});

h('copyAnswer', async id => {
  const p = byId(id);
  try {
    const r = await runPage(views[id].webContents, pageAnswer, p.answer || []);
    if (r.ok) { clipboard.writeText(r.text); toast(p.name + '：已复制回答（' + r.text.length + ' 字）'); }
    else toast(p.name + '：' + r.msg);
  } catch (e) { toast(p.name + '：' + e.message); }
});

h('send', async text => {
  const out = [];
  for (const p of platforms) if (attached.has(p.id)) out.push(await injectOne(p, text));
  return out;
});

h('promptMenu', text => {
  const list = readJson('prompts.json', []);
  const tpl = list.map(it => ({ label: it.title, click: () => win.webContents.send('insert', it.text) }));
  if (tpl.length) tpl.push({ type: 'separator' });
  tpl.push({ label: '把当前输入存为提示词', enabled: !!(text && text.trim()), click: () => {
    list.push({ title: text.trim().replace(/\s+/g, ' ').slice(0, 20), text: text.trim() }); writeJson('prompts.json', list); toast('已保存到提示词库'); } });
  tpl.push({ label: '编辑提示词文件…', click: () => { if (!fs.existsSync(dataFile('prompts.json'))) writeJson('prompts.json', []); shell.openPath(dataFile('prompts.json')); } });
  Menu.buildFromTemplate(tpl).popup({ window: win });
});

app.whenReady().then(() => {
  win = new BrowserWindow({ width: 1700, height: 980, backgroundColor: '#86b9d6', title: 'AI 多窗口对话',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true } });
  win.setMenuBarVisibility(false);
  win.loadFile('ui.html');
  win.on('resize', layout);
});
app.on('window-all-closed', () => app.quit());
