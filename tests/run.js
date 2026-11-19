'use strict';
// Тесты ядра лаунчера. Используют локальный HTTP-сервер вместо серверов Mojang.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-test-'));
process.env.MISTERCRAFT_HOME = tmp;
const TEST_PORT = 18765 + Math.floor(Math.random() * 1000);
process.env.MC_RESOURCES_URL = `http://127.0.0.1:${TEST_PORT}/res`; // до require installer

const rules = require('../src/rules');
const { extractZip } = require('../src/zip');
const V = require('../src/versions');
const installer = require('../src/installer');
const launch = require('../src/launch');
const auth = require('../src/auth');
const javaMod = require('../src/java');
const settings = require('../src/settings');
const P = require('../src/paths');

const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e)); process.exitCode = 1; }
};

// --- минимальный zip с одним файлом (для теста распаковки) ---
function makeZip(files) {
  const locals = []; const centrals = []; let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content); const comp = zlib.deflateRawSync(data);
    const nb = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, comp); centrals.push(ch, nb);
    off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

(async () => {
  console.log('Правила и утилиты');
  await test('allowed(): правила os/features', () => {
    const win = { name: 'windows', arch: 'x64', version: '10.0.22631' };
    assert.strictEqual(rules.allowed(undefined, win), true);
    assert.strictEqual(rules.allowed([{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }], win), true);
    assert.strictEqual(rules.allowed([{ action: 'allow', os: { name: 'osx' } }], win), false);
    assert.strictEqual(rules.allowed([{ action: 'allow', os: { name: 'windows', arch: 'x86' } }], win), false);
    assert.strictEqual(rules.allowed([{ action: 'allow', os: { name: 'windows', version: '^10\\.' } }], win), true);
    assert.strictEqual(rules.allowed([{ action: 'allow', features: { is_demo_user: true } }], win, {}), false);
  });
  await test('mavenPath()', () => {
    assert.strictEqual(rules.mavenPath('net.fabricmc:fabric-loader:0.16.9'), 'net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar');
    assert.strictEqual(rules.mavenPath('org.lwjgl:lwjgl:3.3.3:natives-windows'), 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar');
  });
  await test('распаковка zip + защита от zip-slip', () => {
    const z = path.join(tmp, 't.zip');
    fs.writeFileSync(z, makeZip({ 'a/b.txt': 'hello', '../evil.txt': 'x', 'META-INF/x': 'm' }));
    const out = path.join(tmp, 'unz');
    extractZip(z, out, (n) => !n.startsWith('META-INF/'));
    assert.strictEqual(fs.readFileSync(path.join(out, 'a', 'b.txt'), 'utf8'), 'hello');
    assert.ok(!fs.existsSync(path.join(tmp, 'evil.txt')));
    assert.ok(!fs.existsSync(path.join(out, 'META-INF', 'x')));
  });
  await test('парсинг версии Java', () => {
    assert.strictEqual(javaMod.parseMajor('java version "1.8.0_392"'), 8);
    assert.strictEqual(javaMod.parseMajor('openjdk version "17.0.9" 2023-10-17'), 17);
    assert.strictEqual(javaMod.parseMajor('openjdk version "21" 2023-09-19'), 21);
    assert.strictEqual(javaMod.targetMajor(16), 17);
    assert.ok(javaMod.javaOk(8, 8) && !javaMod.javaOk(17, 8) && javaMod.javaOk(21, 17) && !javaMod.javaOk(8, 17));
  });
  await test('офлайн-аккаунт: UUID и проверка ника', () => {
    assert.strictEqual(auth.offlineUuid('Notch').length, 32);
    assert.strictEqual(auth.offlineUuid('Notch'), auth.offlineUuid('Notch'));
    assert.strictEqual(auth.offlineUuid('Notch').charAt(12), '3');
    assert.throws(() => auth.offlineAccount('a b'));
    assert.strictEqual(auth.offlineAccount('Mister_1').type, 'offline');
  });
  await test('settings: сохранение, шифрование токенов, аккаунты', () => {
    settings.update({ ramMb: 6144, javaPath: 'C:\\j\\java.exe' });
    settings.saveAccount({ id: 'x', type: 'microsoft', name: 'N', uuid: 'u', refreshToken: 'SECRET', mcToken: 'TOK', mcExpires: 1 });
    const raw = fs.readFileSync(P.settings, 'utf8');
    assert.ok(!raw.includes('SECRET') && !raw.includes('"TOK"'));
    settings._reset();
    assert.strictEqual(settings.getPublic().ramMb, 6144);
    assert.strictEqual(settings.getAccount().refreshToken, 'SECRET');
    settings.removeAccount('x');
    assert.strictEqual(settings.listAccounts().accounts.length, 0);
  });

  // ---- интеграционный тест установки с локальным сервером ----
  console.log('Установка и запуск (локальный сервер)');
  const files = {};
  const server = http.createServer((req, res) => {
    const f = files[req.url];
    if (!f) { res.statusCode = 404; return res.end('nf'); }
    res.end(f);
  });
  await new Promise((r) => server.listen(TEST_PORT, '127.0.0.1', r));
  const base = `http://127.0.0.1:${TEST_PORT}`;

  const clientJar = Buffer.from('CLIENTJAR');
  const libJar = Buffer.from('LIBJAR');
  const nativeJar = makeZip({ 'lwjgl.dll': 'DLL', 'META-INF/MANIFEST.MF': 'x' });
  const asset = Buffer.from('ASSET1');
  const aHash = sha1(asset);
  const index = Buffer.from(JSON.stringify({ objects: { 'icons/icon.png': { hash: aHash, size: asset.length } } }));
  files['/client.jar'] = clientJar;
  files['/lib.jar'] = libJar;
  files['/native.jar'] = nativeJar;
  files['/index.json'] = index;
  files[`/res/${aHash.slice(0, 2)}/${aHash}`] = asset;

  const vjson = {
    id: '9.9.9', type: 'release', mainClass: 'net.minecraft.client.main.Main',
    javaVersion: { majorVersion: 21 },
    assetIndex: { id: '99', url: base + '/index.json', sha1: sha1(index), size: index.length },
    downloads: { client: { url: base + '/client.jar', sha1: sha1(clientJar), size: clientJar.length } },
    libraries: [
      { name: 'x:lib:1', downloads: { artifact: { path: 'x/lib/1/lib-1.jar', url: base + '/lib.jar', sha1: sha1(libJar), size: libJar.length } } },
      { name: 'x:osx:1', rules: [{ action: 'allow', os: { name: 'osx' } }], downloads: { artifact: { path: 'x/osx/1/osx-1.jar', url: base + '/nope.jar' } } },
      { name: 'x:nat:1', natives: { windows: 'natives-windows' }, extract: { exclude: ['META-INF/'] },
        downloads: { classifiers: { 'natives-windows': { path: 'x/nat/1/nat-1-natives-windows.jar', url: base + '/native.jar', sha1: sha1(nativeJar), size: nativeJar.length } } } },
    ],
    arguments: {
      game: ['--username', '${auth_player_name}', '--version', '${version_name}', '--assetsDir', '${assets_root}', '--assetIndex', '${assets_index_name}', '--uuid', '${auth_uuid}', '--accessToken', '${auth_access_token}',
        { rules: [{ action: 'allow', features: { is_demo_user: true } }], value: '--demo' }],
      jvm: ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'],
    },
  };
  fs.mkdirSync(path.join(P.versions, '9.9.9'), { recursive: true });
  fs.writeFileSync(V.versionJsonPath('9.9.9'), JSON.stringify(vjson));

  await test('installResolved(): jar, библиотеки, ресурсы, natives', async () => {
    const seen = [];
    await installer.installResolved('9.9.9', (p, t) => seen.push(p));
    assert.ok(fs.existsSync(path.join(P.versions, '9.9.9', '9.9.9.jar')));
    assert.ok(fs.existsSync(path.join(P.libraries, 'x/lib/1/lib-1.jar')));
    assert.ok(!fs.existsSync(path.join(P.libraries, 'x/osx/1/osx-1.jar')), 'osx-библиотека не должна скачиваться');
    assert.ok(fs.existsSync(path.join(P.assets, 'objects', aHash.slice(0, 2), aHash)));
    assert.strictEqual(fs.readFileSync(path.join(P.versions, '9.9.9', 'natives', 'lwjgl.dll'), 'utf8'), 'DLL');
    assert.ok(!fs.existsSync(path.join(P.versions, '9.9.9', 'natives', 'META-INF')));
    assert.strictEqual(seen[seen.length - 1], 100);
    assert.ok(V.listInstalled().find((v) => v.id === '9.9.9' && v.ready && v.hasJar));
  });
  await test('повторная установка использует кэш', async () => {
    delete files['/client.jar']; delete files['/lib.jar'];
    await installer.installResolved('9.9.9');
  });
  await test('launch.build(): аргументы запуска', () => {
    const c = launch.build({ id: '9.9.9', account: { name: 'Steve', uuid: 'abc', type: 'offline', mcToken: '0' }, ramMb: 3072, javaPath: 'java.exe' });
    const a = c.args;
    assert.strictEqual(a[0], '-Xmx3072M');
    assert.ok(a.includes('net.minecraft.client.main.Main'));
    assert.ok(!a.includes('--demo'));
    assert.strictEqual(a[a.indexOf('--username') + 1], 'Steve');
    assert.strictEqual(a[a.indexOf('--version') + 1], '9.9.9');
    const cp = a[a.indexOf('-cp') + 1];
    assert.ok(cp.includes('lib-1.jar') && cp.endsWith('9.9.9.jar') && !cp.includes('osx-1.jar') && !cp.includes('natives-windows'));
    assert.ok(a.indexOf('net.minecraft.client.main.Main') > a.indexOf('-cp'));
    assert.ok(!a.some((x) => /\$\{/.test(x)), 'остались неподставленные переменные');
  });
  await test('наследование версий (как Fabric) и старый формат minecraftArguments', () => {
    const fabric = { id: 'fabric-loader-0.1-9.9.9', inheritsFrom: '9.9.9', type: 'release', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
      arguments: { game: [], jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '] },
      libraries: [{ name: 'net.fabricmc:fabric-loader:0.1', url: base + '/maven/' }] };
    fs.mkdirSync(path.join(P.versions, fabric.id), { recursive: true });
    fs.writeFileSync(V.versionJsonPath(fabric.id), JSON.stringify(fabric));
    const r = V.loadResolved(fabric.id);
    assert.strictEqual(r.jarId, '9.9.9');
    assert.strictEqual(r.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient');
    assert.ok(r.libraries.length === 4 && r.libraries[0].name.startsWith('net.fabricmc'));
    const c = launch.build({ id: fabric.id, account: { name: 'Alex', uuid: 'u', type: 'microsoft', mcToken: 'T' } });
    assert.ok(c.args.some((x) => x.includes('fabric-loader-0.1.jar') || true));
    assert.ok(c.args.join(' ').includes('fabric-loader-0.1.jar'));
    assert.ok(c.args.includes('-DFabricMcEmu= net.minecraft.client.main.Main '));

    const old = { id: '1.7.10', type: 'release', mainClass: 'net.minecraft.client.main.Main', assets: 'legacy',
      minecraftArguments: '--username ${auth_player_name} --session ${auth_session} --gameDir ${game_directory} --assetsDir ${game_assets}',
      libraries: [{ name: 'a:b:1', downloads: { artifact: { path: 'a/b/1/b-1.jar', url: '' } } }] };
    fs.mkdirSync(path.join(P.versions, '1.7.10'), { recursive: true });
    fs.writeFileSync(V.versionJsonPath('1.7.10'), JSON.stringify(old));
    const o = launch.build({ id: '1.7.10', account: { name: 'Old', uuid: 'u1', type: 'offline' } });
    assert.ok(o.args.includes('-cp') && o.args.includes('--session'));
    assert.strictEqual(o.args[o.args.indexOf('--session') + 1], 'token:0:u1');
    assert.ok(o.args.includes('-Djava.library.path=' + path.join(P.versions, '1.7.10', 'natives')));
  });
  await test('удаление версии и защита пути', () => {
    V.deleteVersion('1.7.10');
    assert.ok(!fs.existsSync(path.join(P.versions, '1.7.10')));
    assert.throws(() => V.deleteVersion('../x'));
    assert.ok(!V.validId('..') && V.validId('1.20.1') && V.validId('fabric-loader-0.16.9-1.21.4'));
  });

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nПройдено тестов: ${passed}${process.exitCode ? ' (есть ошибки)' : ''}`);
})();
