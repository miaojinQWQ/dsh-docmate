// What will the panel actually show on first open? Drive the real route with the real
// workspace as the default root and print the first screenful of the tree.
import path from 'node:path';

const plugin = await import('../index.js');

let resource = null;
const ctx = {
  get(name) {
    if (name === 'webServer') return { register: (route) => { resource = route.resource; return () => {}; } };
    if (name === 'workingDirectory') return { defaultDirectory: 'E:\\agent定制' };
    return null;
  },
  effect(fn) {
    fn();
  },
};
plugin.apply(ctx);

const response = await resource(new Request('http://x/api/docmate/tree'));
const body = await response.json();
console.log('root =', body.root);
console.log('entries =', body.entries.length);
for (const entry of body.entries.slice(0, 60)) {
  const depth = entry.path.split('/').length - 1;
  console.log('  '.repeat(depth) + (entry.kind === 'dir' ? '▸ ' : '· ') + entry.name + (entry.ext ? '  [' + entry.ext + ']' : ''));
}
if (body.entries.length > 60) console.log('  … ' + (body.entries.length - 60) + ' more');

const info = await (await resource(new Request('http://x/api/docmate/info'))).json();
console.log('\ndefaultRoot =', info.defaultRoot);
