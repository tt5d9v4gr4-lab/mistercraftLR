'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const P = require('./paths');
const { download } = require('./http');
const { extractZip } = require('./zip');

function requiredMajor(resolved) {
  const m = (resolved.javaVersion && resolved.javaVersion.majorVersion) || 8;
  return m;
}

/** Какую Java реально берём: 16 -> 17 (Adoptium 16 уже не поддерживается). */
function targetMajor(required) {
  return required === 16 ? 17 : required;
}

function parseMajor(text) {
  const m = /version "([^"]+)"/.exec(text) || /openjdk (\d+)/i.exec(text);
  if (!m) return null;
  const v = m[1];
  if (v.startsWith('1.')) return parseInt(v.split('.')[1], 10);
  return parseInt(v.split(/[.\-+_]/)[0], 10);
}

function probe(javaPath) {
  return new Promise((resolve) => {
    execFile(javaPath, ['-version'], { timeout: 10000, windowsHide: true }, (err, so, se) => {
      const major = parseMajor(String(se || '') + String(so || ''));
      resolve(major ? { path: javaPath, major } : null);
    });
  });
}

function safeReaddir(d) {
  try { return fs.readdirSync(d); } catch { return []; }
}

function candidatePaths() {
  const c = [];
  const add = (p) => { if (p && fs.existsSync(p)) c.push(p); };
  if (process.env.JAVA_HOME) add(path.join(process.env.JAVA_HOME, 'bin', 'java.exe'));

  // Собственные runtime лаунчера
  for (const d of safeReaddir(P.runtime)) add(path.join(P.runtime, d, 'bin', 'java.exe'));

  const bases = [];
  for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
    if (!pf) continue;
    for (const v of ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft', 'Semeru', 'AdoptOpenJDK']) bases.push(path.join(pf, v));
  }
  bases.push(path.join(os.homedir(), '.jdks'));
  for (const b of bases) for (const d of safeReaddir(b)) add(path.join(b, d, 'bin', 'java.exe'));

  // Java официального лаунчера Minecraft
  const mojang = path.join(process.env.APPDATA || '', '.minecraft', 'runtime');
  for (const name of safeReaddir(mojang)) {
    const plat = path.join(mojang, name, 'windows-x64', name, 'bin', 'java.exe');
    add(plat);
  }
  return c;
}

function whereJava() {
  return new Promise((resolve) => {
    execFile('where', ['java'], { timeout: 5000, windowsHide: true }, (err, so) => {
      resolve(err ? [] : String(so).split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    });
  });
}

async function findJavas() {
  const paths = [...candidatePaths(), ...(await whereJava())];
  const uniq = [...new Map(paths.map((p) => [p.toLowerCase(), p])).values()];
  const res = (await Promise.all(uniq.map(probe))).filter(Boolean);
  return res.sort((a, b) => a.major - b.major);
}

function findJavaExe(dir, depth = 3) {
  const direct = path.join(dir, 'bin', 'java.exe');
  if (fs.existsSync(direct)) return direct;
  if (depth === 0) return null;
  for (const e of safeReaddir(dir)) {
    const p = path.join(dir, e);
    try {
      if (fs.statSync(p).isDirectory()) {
        const f = findJavaExe(p, depth - 1);
        if (f) return f;
      }
    } catch {}
  }
  return null;
}

function javaOk(major, need) {
  return need <= 8 ? major === 8 : major >= need;
}

async function downloadJre(need, onProgress) {
  const dir = path.join(P.runtime, `jre-${need}`);
  const zip = path.join(P.tmp, `jre-${need}.zip`);
  const url = `https://api.adoptium.net/v3/binary/latest/${need}/ga/windows/x64/jre/hotspot/normal/eclipse`;
  let bytes = 0;
  let last = 0;
  onProgress(null, `Загрузка Java ${need}…`);
  await download(url, zip, {
    onBytes: (n) => {
      bytes += n;
      const now = Date.now();
      if (now - last > 200) {
        last = now;
        onProgress(null, `Загрузка Java ${need}… ${(bytes / 1048576).toFixed(0)} МБ`);
      }
    },
  });
  onProgress(null, `Установка Java ${need}…`);
  fs.rmSync(dir, { recursive: true, force: true });
  extractZip(zip, dir);
  try { fs.unlinkSync(zip); } catch {}
  const exe = findJavaExe(dir);
  if (!exe) throw new Error(`Не удалось установить Java ${need}`);
  // Нормализуем: bin\java.exe лежит прямо в jre-N
  return exe;
}

/**
 * Возвращает путь к java.exe для нужной версии.
 * setting === 'auto' — подбор или загрузка, иначе — путь, выбранный пользователем.
 */
async function ensureJava(required, setting, onProgress = () => {}) {
  const need = targetMajor(required);
  if (setting && setting !== 'auto') {
    if (!fs.existsSync(setting)) throw new Error('Выбранный файл Java не найден: ' + setting);
    const info = await probe(setting);
    if (!info) throw new Error('Не удалось определить версию выбранной Java');
    if (!javaOk(info.major, need)) {
      throw new Error(
        need <= 8
          ? `Для этой версии Minecraft нужна именно Java 8, а выбрана Java ${info.major}`
          : `Для этой версии Minecraft нужна Java ${need} или новее, а выбрана Java ${info.major}`
      );
    }
    return setting;
  }

  const managed = path.join(P.runtime, `jre-${need}`);
  const m = fs.existsSync(managed) ? findJavaExe(managed) : null;
  if (m) return m;

  const found = (await findJavas()).filter((j) => javaOk(j.major, need));
  if (found.length) {
    found.sort((a, b) => Math.abs(a.major - need) - Math.abs(b.major - need));
    return found[0].path;
  }
  return downloadJre(need, onProgress);
}

module.exports = { requiredMajor, targetMajor, parseMajor, findJavas, ensureJava, javaOk };
