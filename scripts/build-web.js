#!/usr/bin/env node
/**
 * 把 miniprogram/core（CommonJS）打包成浏览器可直接加载的单文件 bundle。
 *
 * 为什么不用 webpack/esbuild：
 *   - 这台机器没有构建链依赖，也不想为此引入 npm 依赖；
 *   - core 层只用了 require('./相对路径') 这一种模块形态，一个 40 行的 loader 就够。
 *
 * 产物：web-demo/yizhi-core.js（挂到 window.YizhiCore）
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MP = path.join(__dirname, '..', 'miniprogram');
const OUT = path.join(__dirname, '..', 'web-demo', 'yizhi-core.js');

const ENTRIES = [
  'core/pipeline.js',
  'core/report.js',
  'core/standards.js',
  'core/knowledge.js',
  'core/compare.js',
  'core/manual-fields.js',
  'core/fields.js',
  'core/fit.js',
  'core/fabric.js',
  'core/evidence.js',
  'core/normalize.js',
  'core/extractor.js',
  'core/schema.js',
  'core/data/demo.products.js',
  'core/data/knowledge.data.js',
  'core/data/standards.meta.js',
  'core/data/standards.verified.js'
];

const modules = new Map();

function idOf(abs) {
  return path.relative(MP, abs).replace(/\\/g, '/');
}

function resolveRequire(fromAbs, request) {
  if (request.charAt(0) !== '.') return null; // core 里不该出现裸模块名
  const base = path.resolve(path.dirname(fromAbs), request);
  const candidates = [base, `${base}.js`, path.join(base, 'index.js')];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  throw new Error(`无法解析 require('${request}')，来自 ${idOf(fromAbs)}`);
}

function collect(absPath) {
  const id = idOf(absPath);
  if (modules.has(id)) return;
  const source = fs.readFileSync(absPath, 'utf8');
  modules.set(id, source);

  const re = /require\(\s*(['"])(.+?)\1\s*\)/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const resolved = resolveRequire(absPath, m[2]);
    if (resolved) collect(resolved);
  }
}

for (const entry of ENTRIES) {
  const abs = path.join(MP, entry);
  if (!fs.existsSync(abs)) throw new Error(`入口不存在：${entry}`);
  collect(abs);
}

const parts = [];
parts.push('/* 自动生成，请勿手工编辑：node scripts/build-web.js */');
parts.push('(function () {');
parts.push("  'use strict';");
parts.push('  var defs = {};');
parts.push('  var cache = {};');

for (const [id, source] of modules) {
  parts.push(`  defs[${JSON.stringify(id)}] = function (module, exports, require) {`);
  parts.push(source);
  parts.push('  };');
}

parts.push(`
  function makeRequire(dir) {
    return function (request) {
      var target = request;
      if (request.charAt(0) === '.') {
        var stack = dir.split('/').filter(Boolean);
        var bits = request.split('/');
        for (var i = 0; i < bits.length; i += 1) {
          var b = bits[i];
          if (b === '.' || b === '') continue;
          if (b === '..') stack.pop();
          else stack.push(b);
        }
        target = stack.join('/');
        if (!defs[target] && defs[target + '.js']) target += '.js';
        if (!defs[target] && defs[target + '/index.js']) target += '/index.js';
      }
      if (!defs[target]) throw new Error('模块未打包：' + target + '（来自 ' + dir + '）');
      if (cache[target]) return cache[target].exports;
      var mod = { exports: {} };
      cache[target] = mod;
      defs[target](mod, mod.exports, makeRequire(target.replace(/\\/[^/]*$/, '')));
      return mod.exports;
    };
  }

  var req = makeRequire('');
  window.YizhiCore = {
    analyze: req('core/pipeline.js').analyze,
    emptyFields: req('core/pipeline.js').emptyFields,
    extractOnly: req('core/pipeline.js').extractOnly,
    buildReport: req('core/report.js').buildReport,
    fieldItem: req('core/report.js').fieldItem,
    standards: req('core/standards.js'),
    knowledge: req('core/knowledge.js'),
    compare: req('core/compare.js').buildComparison,
    buildManualFields: req('core/manual-fields.js').buildManualFields,
    fields: req('core/fields.js'),
    fit: req('core/fit.js').assessFit,
    fabric: req('core/fabric.js'),
    evidence: req('core/evidence.js'),
    normalize: req('core/normalize.js'),
    demos: req('core/data/demo.products.js')
  };
})();
`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, parts.join('\n'), 'utf8');

const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log(`打包完成：${path.relative(path.join(__dirname, '..'), OUT)}（${modules.size} 个模块，${kb}KB）`);
