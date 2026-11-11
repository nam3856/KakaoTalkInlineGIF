import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const packageRoot = path.resolve(process.argv[2] || '.');
assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert.equal(process.version, 'v24.22.2');
const info = JSON.parse(await readFile(path.join(packageRoot, 'node_modules/frida/package.json'), 'utf8'));
assert.equal(info.version, '17.23.2');
const frida = await import(pathToFileURL(path.join(packageRoot, 'node_modules/frida/build/src/frida.js')).href);
const device = await frida.getLocalDevice();
assert.equal(device.id, 'local');
console.log(JSON.stringify({node: process.version, architecture: process.arch, frida: info.version, localDevice: true, attached: false}));
