/**
 * 把 src/client/index.js（CJS 风格源码）包上 window.__ModuleLoader__ 头尾，
 * 产出 lib/client.js —— 与 tsdown 产物的加载特征一致，无需任何构建依赖。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'

const PLUGIN_ID = '@dsh-external/dsh-session-folders'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(path.join(root, 'src', 'client', 'index.js'), 'utf8')

const out = [
  'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
  'var module = { exports: {} }; var exports = module.exports;',
  src,
  'return module.exports; } });',
  '',
].join('\n')

mkdirSync(path.join(root, 'lib'), { recursive: true })
writeFileSync(path.join(root, 'lib', 'client.js'), out)
console.log('build-client: lib/client.js written (' + out.length + ' bytes)')
