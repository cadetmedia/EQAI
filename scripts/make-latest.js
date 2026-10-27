// Generates dist/latest.json for the in-app updater, from package.json + the
// GitHub repo context. Run by the release workflow after the build.
const fs = require('fs');
const path = require('path');
const { friendlyLabel } = require('../src/version');
const pkg = require('../package.json');

const repo = process.env.GITHUB_REPOSITORY || 'cadetmedia/EQAI';
const notes = (process.env.RELEASE_NOTES || '').split('\n')[0].slice(0, 300);

const data = {
  version: pkg.version,
  label: friendlyLabel(pkg.version),
  url: `https://github.com/${repo}/releases/latest`,
  notes,
};

fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync(path.join('dist', 'latest.json'), JSON.stringify(data, null, 2));
console.log('Wrote dist/latest.json:', data);
