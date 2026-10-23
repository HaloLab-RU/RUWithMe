import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {initWorkspace} from '../scripts/init-workspace.mjs';

async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), 'ruwithme-public-'));
  const root = await realpath(path);
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = join(root, 'examples/workspace');
  await mkdir(join(source, 'research/Synthetic-Project/notes'), {recursive: true});
  await mkdir(join(source, 'records/days'), {recursive: true});
  await mkdir(join(source, 'inbox'), {recursive: true});
  await writeFile(join(source, 'research/Synthetic-Project/README.md'), '# Fictional project\n');
  await writeFile(join(source, 'research/Synthetic-Project/notes/source.bin'), Buffer.from([0, 255, 128, 10]));
  await writeFile(join(source, '.demo.json'), '{"synthetic":true}\n');
  await writeFile(join(source, 'research/.priorities.json'), '{"version":1}\n');
  await writeFile(join(source, 'inbox/.ideas.json'), '{"ideas":[]}\n');
  await writeFile(join(source, 'inbox/.metadata.json'), '{"files":{}}\n');
  return {root, source, target: join(root, 'workspace')};
}

test('a fresh checkout receives independent synthetic bytes, metadata and empty folders', async t => {
  const {root, source, target} = await fixture(t);
  assert.deepEqual(await initWorkspace({root}), {created: true, path: target});
  for (const name of ['.demo.json', 'research/.priorities.json', 'inbox/.ideas.json', 'inbox/.metadata.json', 'research/Synthetic-Project/notes/source.bin']) {
    assert.deepEqual(await readFile(join(target, name)), await readFile(join(source, name)));
  }
  assert.deepEqual(await readdir(join(target, 'records/days')), []);
  await writeFile(join(target, 'research/Synthetic-Project/README.md'), 'User changes\n');
  assert.equal(await readFile(join(source, 'research/Synthetic-Project/README.md'), 'utf8'), '# Fictional project\n');
  assert.deepEqual(await readdir(join(root, '.ruwithme/setup')), []);
});

test('a Git-like checkout recreates empty containers and canonical project material folders', async t => {
  const {root, source, target} = await fixture(t);
  await rm(source, {recursive: true});
  const cards = ['research/Fictional-Project', 'courses/Fall-2026/Fictional-Course'];
  for (const folder of cards) {
    await mkdir(join(source, folder), {recursive: true});
    await writeFile(join(source, folder, 'README.md'), '# Synthetic example\n');
  }
  // A nested source README is a document rather than another workspace card.
  await mkdir(join(source, 'research/Fictional-Project/reference'), {recursive: true});
  await writeFile(join(source, 'research/Fictional-Project/reference/README.md'), '# Source document\n');

  assert.equal((await initWorkspace({root})).created, true);
  for (const folder of ['research', 'courses', 'learn', 'career', 'admin', 'personal', 'inbox', 'records/days']) {
    assert.ok(Array.isArray(await readdir(join(target, folder))));
  }
  for (const folder of cards) {
    assert.deepEqual(await readdir(join(target, folder, 'notes')), []);
    assert.deepEqual(await readdir(join(target, folder, 'files')), []);
  }
  assert.deepEqual(await readdir(join(target, 'research/Fictional-Project/reference')), ['README.md']);
  await writeFile(join(target, 'research/Fictional-Project/README.md'), 'Local edit\n');
  assert.equal((await initWorkspace({root})).created, false);
  assert.equal(await readFile(join(target, 'research/Fictional-Project/README.md'), 'utf8'), 'Local edit\n');
});

test('reinstallation preserves all existing workspace content and never requires examples', async t => {
  const {root, source, target} = await fixture(t);
  await mkdir(target);
  await writeFile(join(target, 'my-notes.md'), 'Private content\n');
  await rm(source, {recursive: true});
  assert.equal((await initWorkspace({root})).created, false);
  assert.equal(await readFile(join(target, 'my-notes.md'), 'utf8'), 'Private content\n');
  assert.deepEqual(await readdir(root), ['examples', 'workspace']);
});

test('an existing empty workspace is preserved without installing defaults', async t => {
  const {root, target} = await fixture(t);
  await mkdir(target);
  assert.equal((await initWorkspace({root})).created, false);
  assert.deepEqual(await readdir(target), []);
  assert.deepEqual(await readdir(root), ['examples', 'workspace']);
});

test('example file and directory symlinks are rejected before creating a workspace', async t => {
  for (const directory of [false, true]) {
    const {root, source, target} = await fixture(t);
    const outside = join(root, directory ? 'private-folder' : 'private-file');
    if (directory) await mkdir(outside);
    else await writeFile(outside, 'Must not be copied');
    await symlink(outside, join(source, 'escape'));
    await assert.rejects(initWorkspace({root}), /symbolic links/);
    await assert.rejects(readFile(target), {code: 'ENOENT'});
    assert.ok(!(await readdir(root)).includes('.ruwithme'));
  }
});

test('private histories in examples abort the entire initialization', async t => {
  const {root, source, target} = await fixture(t);
  await mkdir(join(source, 'research/Synthetic-Project/.edit-history'));
  await writeFile(join(source, 'research/Synthetic-Project/.edit-history/old.md'), 'Must not be copied');
  await assert.rejects(initWorkspace({root}), /Private or unsupported hidden example path/);
  await assert.rejects(readFile(target), {code: 'ENOENT'});
  assert.ok(!(await readdir(root)).includes('.ruwithme'));
});

test('runtime symlinks are rejected without writing through to another folder', async t => {
  const {root, target} = await fixture(t);
  const outside = join(root, 'elsewhere');
  await mkdir(outside);
  await symlink(outside, join(root, '.ruwithme'));
  await assert.rejects(initWorkspace({root}), /real directories/);
  await assert.rejects(readFile(target), {code: 'ENOENT'});
  assert.deepEqual(await readdir(outside), []);
});

test('concurrent initializers publish one complete workspace and clean their staging folders', async t => {
  const {root, target} = await fixture(t);
  const results = await Promise.all([initWorkspace({root}), initWorkspace({root})]);
  assert.equal(results.filter(result => result.created).length, 1);
  assert.equal(await readFile(join(target, 'research/Synthetic-Project/README.md'), 'utf8'), '# Fictional project\n');
  assert.deepEqual(await readdir(join(root, '.ruwithme/setup')), []);
});
