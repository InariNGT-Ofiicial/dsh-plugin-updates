import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const pkg=JSON.parse(await readFile('package.json','utf8'));
assert.equal(process.argv[2],`v${pkg.version}`,'Tag and package version differ');
assert.match(await readFile('docs/RELEASE.md','utf8'),new RegExp(`v${pkg.version.replaceAll('.','\\.')}`),'Release notes need this version');
assert.equal(pkg.repository?.url,'https://github.com/InariNGT-Ofiicial/dsh-plugin-updates.git');
console.log(`Release metadata verified: v${pkg.version}`);
