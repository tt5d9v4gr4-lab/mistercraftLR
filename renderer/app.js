'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return e;
}

async function call(ch, ...args) {
  const r = await window.api.invoke(ch, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

const TYPE_TABS = {
  release: ['release'],
  snapshot: ['snapshot'],
  old: ['old_beta', 'old_alpha'],
};
const LOADER_NAME = { vanilla: 'Vanilla', fabric: 'Fabric', forge: 'Forge' };

const S = {
  settings: null,
  info: null,
  manifest: null,
  installed: [],
  tab: 'release',
  query: '',
  selected: { mc: null, loader: 'vanilla' },
  support: {},
  state: 'idle',
  accounts: [],
  active: null,
  msUrl: null,
};

/* ---------- уведомления ---------- */
function toast(text, type = 'info', withLog = false) {
  const t = h('div', { class: 'toast ' + type }, h('div', { class: 't', text }));
  if (withLog) t.append(h('button', { text: 'Журнал', onclick: () => { openModal('m-log'); t.remove(); } }));
  $('#toasts').append(t);
  setTimeout(() => t.remove(), withLog ? 14000 : 7000);
}
const fail = (e) => toast(e && e.message ? e.message : String(e), 'error');

/* ---------- модальные окна ---------- */
function openModal(id) {
  if (id === 'm-settings') renderSettings();
  if (id === 'm-account') renderAccounts();
  if (id === 'm-installed') renderInstalled();
  if (id === 'm-log') renderLog();
  $('#' + id).classList.add('open');
}
function closeModals() { $$('.modal.open').forEach((m) => m.classList.remove('open')); }

/* ---------- аватар ---------- */
function drawAvatar(canvas, name) {
  const c = canvas.getContext('2d');
  const s = canvas.width;
  c.imageSmoothingEnabled = false;
  c.fillStyle = '#111';
  c.fillRect(0, 0, s, s);
  c.fillStyle = '#ffcc00';
  c.fillRect(1, 1, s - 2, s - 2);
  c.fillStyle = '#0a0a0a';
  c.fillRect(3, 3, s - 6, s - 6);
  c.fillStyle = '#ffcc00';
  c.font = `bold ${Math.round(s * 0.6)}px Bahnschrift, Segoe UI, sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText((name || '?').slice(0, 1).toUpperCase(), s / 2, s / 2 + 1);
}

/* ---------- версии ---------- */
function isInstalled(mc, loader) {
  if (loader === 'vanilla') return S.installed.some((v) => v.id === mc);
  return S.installed.some((v) => v.loader === loader && v.mc === mc);
}

function renderVersions() {
  const list = $('#vlist');
  list.textContent = '';
  if (!S.manifest) {
    list.append(h('div', { class: 'empty' }, 'Список версий не загружен.', h('br'), h('button', { class: 'btn ghost small', style: 'margin-top:10px', text: 'Повторить', onclick: loadManifest })));
    return;
  }
  const types = TYPE_TABS[S.tab];
  const q = S.query.trim().toLowerCase();
  const items = S.manifest.versions.filter((v) => types.includes(v.type) && (!q || v.id.toLowerCase().includes(q)));
  if (!items.length) { list.append(h('div', { class: 'empty', text: 'Ничего не найдено' })); return; }
  const frag = document.createDocumentFragment();
  for (const v of items) {
    const row = h('div', { class: 'vitem' + (v.id === S.selected.mc ? ' sel' : ''), 'data-id': v.id },
      h('span', { class: 'id', text: v.id }),
      isInstalled(v.id, 'vanilla') ? h('span', { class: 'badge', text: 'установлена' }) : null,
      h('span', { class: 'date', text: new Date(v.releaseTime).toLocaleDateString('ru-RU') })
    );
    row.addEventListener('click', () => selectVersion(v.id));
    frag.append(row);
  }
  list.append(frag);
}

async function selectVersion(id) {
  S.selected.mc = id;
  saveSelected();
  renderVersions();
  renderSelected();
  await refreshSupport(id);
}

function saveSelected() {
  call('settings:set', { selected: S.selected }).catch(() => {});
}

async function refreshSupport(mc) {
  if (!mc) return;
  if (!S.support[mc]) {
    try { S.support[mc] = await call('loaders:support', mc); } catch { S.support[mc] = { fabric: null, forge: null }; }
  }
  if (S.selected.mc !== mc) return;
  const sup = S.support[mc];
  for (const b of $$('#loader-chips button')) {
    const l = b.dataset.loader;
    b.disabled = l !== 'vanilla' && sup[l] === false;
  }
  if (S.selected.loader !== 'vanilla' && sup[S.selected.loader] === false) {
    S.selected.loader = 'vanilla';
    saveSelected();
  }
  renderLoaders();
  renderSelected();
}

function renderLoaders() {
  for (const b of $$('#loader-chips button')) b.classList.toggle('active', b.dataset.loader === S.selected.loader);
}

function renderSelected() {
  const { mc, loader } = S.selected;
  $('#hero-ver').textContent = mc ? 'Minecraft ' + mc : 'Версия не выбрана';
  $('#hero-loader').textContent = loader === 'vanilla' ? '' : LOADER_NAME[loader];
  $('#hero-status').textContent = !mc ? '' : isInstalled(mc, loader) ? 'Установлена · готова к запуску' : 'Будет загружена при запуске';
  renderPlay();
}

function renderPlay() {
  const btn = $('#btn-play');
  const lbl = $('#play-label');
  const busy = S.state !== 'idle';
  btn.disabled = busy || !S.selected.mc;
  lbl.textContent = S.state === 'installing' ? 'УСТАНОВКА…' : S.state === 'running' ? 'ИГРА ЗАПУЩЕНА' : 'ИГРАТЬ';
  $('#btn-stop').classList.toggle('hidden', S.state !== 'running');
}

/* ---------- аккаунты ---------- */
function applyAccounts(d) {
  S.accounts = d.accounts;
  S.active = d.active;
  const a = S.accounts.find((x) => x.id === S.active);
  $('#acc-name').textContent = a ? a.name : 'Нет аккаунта';
  $('#acc-type').textContent = a ? (a.type === 'microsoft' ? 'Microsoft' : 'Офлайн') : 'Нажмите, чтобы войти';
  drawAvatar($('#acc-avatar'), a ? a.name : '?');
  if ($('#m-account').classList.contains('open')) renderAccounts();
}

function renderAccounts() {
  const list = $('#acc-list');
  list.textContent = '';
  if (!S.accounts.length) list.append(h('div', { class: 'hint', text: 'Аккаунтов пока нет. Войдите через Microsoft или добавьте офлайн-профиль.' }));
  for (const a of S.accounts) {
    const cv = h('canvas', { width: 30, height: 30 });
    drawAvatar(cv, a.name);
    list.append(h('div', { class: 'acc-row' + (a.id === S.active ? ' active' : '') },
      cv,
      h('span', { class: 'nm', text: a.name }),
      h('span', { class: 'badge', text: a.type === 'microsoft' ? 'Microsoft' : 'Офлайн' }),
      a.id === S.active ? h('span', { class: 'badge', text: 'выбран' }) : h('button', { class: 'btn ghost small', text: 'Выбрать', onclick: () => call('accounts:select', a.id).then(applyAccounts).catch(fail) }),
      h('button', { class: 'btn danger small', text: 'Удалить', onclick: () => call('accounts:remove', a.id).then(applyAccounts).catch(fail) })
    ));
  }
  $('#ms-client-id').value = S.settings.msClientId || '';
}

async function startMicrosoft() {
  const cid = $('#ms-client-id').value.trim();
  if (!cid) { toast('Укажите Azure Client ID (инструкция в README).', 'error'); return; }
  S.settings = await call('settings:set', { msClientId: cid });
  $('#btn-ms').disabled = true;
  try {
    const d = await call('auth:microsoft');
    applyAccounts(d);
    toast('Вход выполнен');
  } catch (e) {
    fail(e);
  } finally {
    $('#btn-ms').disabled = false;
    $('#ms-box').classList.add('hidden');
  }
}

async function addOffline() {
  try {
    applyAccounts(await call('accounts:addOffline', $('#off-name').value));
    $('#off-name').value = '';
  } catch (e) { fail(e); }
}

/* ---------- установленные ---------- */
async function reloadInstalled() {
  try { S.installed = await call('versions:installed'); } catch { S.installed = []; }
  renderSelected();
  renderVersions();
  if ($('#m-installed').classList.contains('open')) renderInstalled();
}

function renderInstalled() {
  const list = $('#inst-list');
  list.textContent = '';
  if (!S.installed.length) { list.append(h('div', { class: 'hint', text: 'Установленных версий пока нет.' })); return; }
  for (const v of S.installed.slice().sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))) {
    list.append(h('div', { class: 'inst-row' },
      h('span', { class: 'nm', text: v.id }),
      v.loader !== 'vanilla' ? h('span', { class: 'badge', text: LOADER_NAME[v.loader] || v.loader }) : null,
      h('span', { class: 'badge', text: v.type }),
      h('button', {
        class: 'btn danger small', text: 'Удалить', disabled: S.state !== 'idle',
        onclick: async () => {
          if (!confirm(`Удалить версию ${v.id}?\nСохранения и моды не затрагиваются.`)) return;
          try { await call('versions:delete', v.id); await reloadInstalled(); } catch (e) { fail(e); }
        },
      })
    ));
  }
}

/* ---------- настройки ---------- */
async function renderSettings() {
  const total = S.info.totalMb;
  const max = Math.max(2048, Math.floor((total * 0.75) / 512) * 512);
  const r = $('#ram-range');
  r.max = max;
  r.value = Math.min(S.settings.ramMb, max);
  $('#ram-label').textContent = (r.value / 1024).toFixed(1) + ' ГБ';
  $('#chk-hide').checked = !!S.settings.hideOnLaunch;
  $('#root-path').textContent = 'Папка данных: ' + S.info.root;

  const sel = $('#java-select');
  sel.textContent = '';
  sel.append(h('option', { value: 'auto', text: 'Авто (подобрать / скачать)' }));
  if (S.settings.javaPath !== 'auto') sel.append(h('option', { value: S.settings.javaPath, text: S.settings.javaPath }));
  try {
    for (const j of await call('java:list')) {
      if (j.path !== S.settings.javaPath) sel.append(h('option', { value: j.path, text: `Java ${j.major} — ${j.path}` }));
    }
  } catch {}
  sel.value = S.settings.javaPath;
}

/* ---------- журнал ---------- */
async function renderLog() {
  const pre = $('#log-pre');
  try { pre.textContent = (await call('game:log')).join('\n'); } catch { pre.textContent = ''; }
  pre.scrollTop = pre.scrollHeight;
}

/* ---------- загрузка данных ---------- */
async function loadManifest() {
  try {
    S.manifest = await call('versions:manifest');
    if (S.manifest.offline) toast('Нет подключения: показан сохранённый список версий.');
    if (!S.selected.mc) S.selected.mc = S.manifest.latest.release;
  } catch (e) {
    S.manifest = null;
    fail(e);
  }
  renderVersions();
  renderSelected();
  refreshSupport(S.selected.mc);
}

async function play() {
  if (!S.active) { toast('Сначала добавьте аккаунт.', 'error'); openModal('m-account'); return; }
  try {
    await call('game:play', { mc: S.selected.mc, loader: S.selected.loader });
  } catch (e) {
    fail(e);
  } finally {
    reloadInstalled();
  }
}

/* ---------- события ---------- */
function bind() {
  $('#btn-min').onclick = () => call('win:min');
  $('#btn-max').onclick = () => call('win:max');
  $('#btn-close').onclick = () => call('win:close');

  $$('#tabs button').forEach((b) => b.addEventListener('click', () => {
    S.tab = b.dataset.tab;
    $$('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
    renderVersions();
  }));
  $('#search').addEventListener('input', (e) => { S.query = e.target.value; renderVersions(); });
  $$('#loader-chips button').forEach((b) => b.addEventListener('click', () => {
    if (b.disabled) return;
    S.selected.loader = b.dataset.loader;
    saveSelected();
    renderLoaders();
    renderSelected();
  }));

  $('#btn-play').onclick = play;
  $('#btn-stop').onclick = () => call('game:stop').catch(fail);
  $('#btn-settings').onclick = () => openModal('m-settings');
  $('#btn-account').onclick = () => openModal('m-account');
  $('#btn-installed').onclick = () => openModal('m-installed');
  $('#btn-open-folder').onclick = () => call('folder:open').catch(fail);
  $('#btn-open-folder2').onclick = () => call('folder:open').catch(fail);

  $$('[data-close]').forEach((b) => b.addEventListener('click', closeModals));
  $$('.modal').forEach((m) => m.addEventListener('mousedown', (e) => { if (e.target === m) closeModals(); }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });

  // Настройки
  $('#ram-range').addEventListener('input', (e) => { $('#ram-label').textContent = (e.target.value / 1024).toFixed(1) + ' ГБ'; });
  $('#ram-range').addEventListener('change', async (e) => { S.settings = await call('settings:set', { ramMb: Number(e.target.value) }); });
  $('#chk-hide').addEventListener('change', async (e) => { S.settings = await call('settings:set', { hideOnLaunch: e.target.checked }); });
  $('#java-select').addEventListener('change', async (e) => { S.settings = await call('settings:set', { javaPath: e.target.value }); });
  $('#java-browse').onclick = async () => {
    try {
      const p = await call('java:browse');
      if (p) { S.settings = await call('settings:set', { javaPath: p }); renderSettings(); }
    } catch (e) { fail(e); }
  };

  // Аккаунты
  $('#btn-ms').onclick = startMicrosoft;
  $('#btn-off-add').onclick = addOffline;
  $('#off-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') addOffline(); });
  $('#ms-open').onclick = () => S.msUrl && call('link:open', S.msUrl).catch(fail);
  $('#ms-copy').onclick = () => navigator.clipboard.writeText($('#ms-code').textContent).then(() => toast('Код скопирован'));
  $('#ms-cancel').onclick = () => { call('auth:cancel'); $('#ms-box').classList.add('hidden'); };

  // События от main
  window.api.on('progress', ({ percent, text }) => {
    const fill = $('#bar-fill');
    $('#status-text').textContent = text || (S.state === 'running' ? 'Игра запущена' : 'Готов к запуску');
    $('#status-pct').textContent = percent != null && percent > 0 ? percent + '%' : '';
    if (percent == null && S.state === 'installing') {
      fill.classList.add('indet');
    } else {
      fill.classList.remove('indet');
      fill.style.width = (percent || 0) + '%';
    }
  });
  window.api.on('state', (s) => {
    S.state = s;
    renderPlay();
    if (s === 'idle') {
      $('#bar-fill').classList.remove('indet');
      $('#bar-fill').style.width = '0%';
      $('#status-text').textContent = 'Готов к запуску';
      $('#status-pct').textContent = '';
      reloadInstalled();
    }
  });
  window.api.on('log', (line) => {
    if ($('#m-log').classList.contains('open')) {
      const pre = $('#log-pre');
      pre.append(line + '\n');
      pre.scrollTop = pre.scrollHeight;
    }
  });
  window.api.on('auth:code', ({ userCode, url }) => {
    S.msUrl = url;
    $('#ms-code').textContent = userCode;
    $('#ms-box').classList.remove('hidden');
    if (url) call('link:open', url).catch(() => {});
  });
  window.api.on('toast', ({ type, text, log }) => toast(text, type, log));
}

async function init() {
  bind();
  try {
    S.info = await call('app:info');
    S.settings = await call('settings:get');
    S.selected = { ...S.settings.selected };
    applyAccounts(await call('accounts:list'));
    S.state = await call('game:state');
    renderPlay();
    await reloadInstalled();
  } catch (e) {
    fail(e);
  }
  renderLoaders();
  await loadManifest();
}

init();
