// Version helpers shared by the main process.
//
// Release naming scheme (semver under the hood, friendly label for users):
//   1.0.0-alpha.0  -> "Alpha 1.0"      (first release)
//   1.0.0-alpha.1  -> "Alpha 1.1"      (more alphas...)
//   1.0.0-beta.0   -> "Beta 1.0"       (then betas...)
//   1.0.0          -> "1.0"            (then plain versions, no flag)
//   1.1.0          -> "1.1"
// To cut a release, bump "version" in package.json following this pattern.

function friendlyLabel(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta)\.(\d+))?$/.exec(v || '');
  if (!m) return 'v' + (v || '?');
  const [, maj, min, , chan, n] = m;
  if (chan) {
    const C = chan[0].toUpperCase() + chan.slice(1);
    return `${C} ${maj}.${n}`;
  }
  return `${maj}.${min}`;
}

function parseV(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v || '');
  if (!m) return null;
  return { nums: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] };
}

// Returns 1 if a > b, -1 if a < b, 0 if equal. Honors semver prerelease rules
// (a release outranks its prereleases; alpha < beta; numeric identifiers compare
// numerically).
function compareVersions(a, b) {
  const pa = parseV(a);
  const pb = parseV(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1; // release > prerelease
  if (pb.pre.length === 0) return -1;
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (+x !== +y) return +x < +y ? -1 : 1;
    } else if (xn) {
      return -1; // numeric identifiers are lower than alphanumeric
    } else if (yn) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

module.exports = { friendlyLabel, compareVersions };
