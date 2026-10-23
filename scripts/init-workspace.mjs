import {constants} from 'node:fs';
import {lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, rmdir, writeFile} from 'node:fs/promises';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicMetadata = new Set([
  '.demo.json',
  'research/.priorities.json',
  'inbox/.ideas.json',
  'inbox/.metadata.json',
]);
const canonicalReadme = path => /^(?:(?:research|learn|career|admin|personal)\/[^/]+|courses\/[^/]+\/[^/]+)\/README\.md$/.test(path)
  && !path.split('/').some(part => part.startsWith('.') || /[\\\p{Cc}]/u.test(part));
const containers = ['research', 'courses', 'learn', 'career', 'admin', 'personal', 'inbox', 'records/days'];

async function statIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function realDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error('Workspace setup requires real directories without symbolic links.');
  }
  return info;
}

async function readExamples(source) {
  const directories = [];
  const files = [];
  await realDirectory(source);

  async function visit(directory) {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      if (/[\\\p{Cc}]/u.test(entry.name)) throw new Error('Synthetic example filenames cannot contain backslashes or control characters.');
      const path = join(directory, entry.name);
      const name = relative(source, path).split(sep).join('/');
      if (entry.name.startsWith('.') && entry.name !== '.gitkeep' && !publicMetadata.has(name)) {
        throw new Error('Private or unsupported hidden example path: ' + name);
      }
      const info = await lstat(path);
      if (info.isSymbolicLink() || await realpath(path) !== path) {
        throw new Error('Synthetic examples cannot contain symbolic links: ' + name);
      }
      if (info.isDirectory()) {
        directories.push(name);
        await visit(path);
      } else if (info.isFile()) {
        // Read only regular, non-linked source paths. Retain the source bytes;
        // do not interpret documents as instructions or use a live workspace.
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
            throw new Error('Synthetic example changed while being read: ' + name);
          }
          files.push([name, await handle.readFile()]);
        } finally {
          await handle.close();
        }
      } else {
        throw new Error('Synthetic examples must contain regular files and directories: ' + name);
      }
    }
  }

  await visit(source);
  return {directories, files};
}

/** Initialize once; even an existing empty workspace belongs to the user. */
export async function initWorkspace({root = projectRoot} = {}) {
  const checkout = resolve(root);
  const target = join(checkout, 'workspace');
  await realDirectory(checkout);
  if (await statIfPresent(target)) return {created: false, path: target};

  const examples = join(checkout, 'examples');
  await realDirectory(examples);
  const content = await readExamples(join(examples, 'workspace'));
  const runtime = join(checkout, '.ruwithme');
  const setup = join(runtime, 'setup');
  await mkdir(runtime, {recursive: true, mode: 0o700});
  await realDirectory(runtime);
  await mkdir(setup, {recursive: true, mode: 0o700});
  await realDirectory(setup);

  let staging = await mkdtemp(join(setup, 'workspace-'));
  let reservation = null;
  try {
    for (const name of content.directories) await mkdir(join(staging, name), {recursive: true});
    // Git does not retain empty directories. Recreate only the application's
    // canonical containers in this new staging tree, never in an existing home.
    for (const name of containers) await mkdir(join(staging, name), {recursive: true});
    for (const [name] of content.files) {
      if (!canonicalReadme(name)) continue;
      for (const folder of ['notes', 'files']) await mkdir(join(staging, dirname(name), folder), {recursive: true});
    }
    for (const [name, bytes] of content.files) await writeFile(join(staging, name), bytes, {flag: 'wx'});
    if ((await lstat(staging)).dev !== (await lstat(checkout)).dev) {
      throw new Error('Workspace setup staging must be on the same filesystem as the checkout.');
    }

    // Exclusive mkdir prevents another installer or an existing empty user
    // directory from becoming a rename target. Only our own empty reservation
    // may be replaced by the fully prepared directory.
    try {
      await mkdir(target);
    } catch (error) {
      if (error.code === 'EEXIST') return {created: false, path: target};
      throw error;
    }
    reservation = await lstat(target);
    const current = await lstat(target);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== reservation.dev || current.ino !== reservation.ino) {
      throw new Error('The workspace destination changed during setup; no files were replaced.');
    }
    await rename(staging, target);
    staging = null;
    reservation = null;
    return {created: true, path: target};
  } finally {
    if (reservation) {
      const current = await statIfPresent(target);
      if (current?.isDirectory() && current.dev === reservation.dev && current.ino === reservation.ino) {
        // rmdir never removes files placed there by another process.
        await rmdir(target).catch(error => {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
        });
      }
    }
    if (staging) await rm(staging, {recursive: true, force: true});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await initWorkspace();
    console.log(result.created
      ? 'Initialized workspace/ from the public synthetic examples.'
      : 'Existing workspace/ preserved; no workspace files were changed.');
  } catch (error) {
    console.error('Workspace setup failed: ' + error.message);
    process.exitCode = 1;
  }
}
