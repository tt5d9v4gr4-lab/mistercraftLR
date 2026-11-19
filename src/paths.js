'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

const root =
  process.env.MISTERCRAFT_HOME ||
  path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), '.mistercraft');

const P = {
  root,
  versions: path.join(root, 'versions'),
  libraries: path.join(root, 'libraries'),
  assets: path.join(root, 'assets'),
  runtime: path.join(root, 'runtime'),
  tmp: path.join(root, 'tmp'),
  settings: path.join(root, 'launcher_settings.json'),
  manifest: path.join(root, 'version_manifest.json'),
  ensure() {
    for (const k of ['root', 'versions', 'libraries', 'assets', 'runtime', 'tmp']) {
      fs.mkdirSync(P[k], { recursive: true });
    }
  },
};

module.exports = P;
