import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'ava';
import {globby, globbySync, globbyStream} from '../index.js';
import {
	createContextAwareFs,
	createTemporaryGitRepository,
} from './utilities.js';

const getGitFiles = repository => execFileSync(
	'git',
	['ls-files', '--cached', '--others', '--exclude-standard'],
	{cwd: repository, encoding: 'utf8'},
)
	.trim()
	.split(/\r?\n/u)
	.filter(Boolean)
	.sort();

const createFixture = (files, {initGit = false} = {}) => {
	const repository = createTemporaryGitRepository();
	if (initGit) {
		execFileSync('git', ['init'], {cwd: repository});
	}

	for (const [relativePath, content] of Object.entries(files)) {
		const fullPath = path.join(repository, relativePath);
		fs.mkdirSync(path.dirname(fullPath), {recursive: true});
		fs.writeFileSync(fullPath, content);
	}

	return repository;
};

const collectStream = async (patterns, options) => {
	const results = [];
	for await (const entry of globbyStream(patterns, options)) {
		results.push(entry);
	}

	return results;
};

const createReaddirCountingFs = ({contextAware = true} = {}) => {
	const readDirectories = [];
	const customFs = contextAware ? createContextAwareFs() : {...fs};
	const originalReaddir = fs.readdir;
	const originalReaddirSync = fs.readdirSync;

	customFs.readdir = function (directoryPath, ...args) {
		if (this !== customFs) {
			throw new Error('Detached readdir context');
		}

		readDirectories.push(path.resolve(directoryPath));
		return originalReaddir.call(fs, directoryPath, ...args);
	};

	customFs.readdirSync = function (directoryPath, ...args) {
		if (this !== customFs) {
			throw new Error('Detached readdirSync context');
		}

		readDirectories.push(path.resolve(directoryPath));
		return originalReaddirSync.call(fs, directoryPath, ...args);
	};

	const countReadsInside = target => {
		const resolved = path.resolve(target);
		return readDirectories.filter(directory => directory === resolved || directory.startsWith(`${resolved}${path.sep}`)).length;
	};

	return {fs: customFs, countReadsInside};
};

test('directory-only rule keeps regular file with matching name across async, sync, and stream (issue #282)', async t => {
	const repository = createFixture({
		'.gitignore': 'build/\n',
		build: 'binary-file\n',
		'src/index.js': '',
		'src/build/out.js': '',
	}, {initGit: true});

	try {
		const expected = getGitFiles(repository);
		t.deepEqual(expected, ['.gitignore', 'build', 'src/index.js']);

		const options = {
			cwd: repository,
			dot: true,
			gitignore: true,
			ignore: ['.git'],
		};
		const asyncResults = await globby(['**/*'], options);
		const syncResults = globbySync(['**/*'], options);
		const streamResults = await collectStream(['**/*'], options);

		t.deepEqual(asyncResults.sort(), expected);
		t.deepEqual(syncResults.sort(), expected);
		t.deepEqual(streamResults.sort(), expected);
	} finally {
		fs.rmSync(repository, {recursive: true, force: true});
	}
});

test('directory-only rule still never enumerates ignored directories even when keeping a file of the same name', async t => {
	const repository = createFixture({
		'.gitignore': 'build/\n',
		build: 'regular-file\n',
		'src/index.js': '',
		'src/build/out.js': '',
		'src/build/nested/deep.js': '',
	});

	try {
		const {fs: countingFs, countReadsInside} = createReaddirCountingFs();
		const ignoredDirectory = path.join(repository, 'src', 'build');

		const asyncResults = await globby(['**/*'], {cwd: repository, gitignore: true, fs: countingFs});
		t.deepEqual(asyncResults.sort(), ['build', 'src/index.js']);
		t.is(countReadsInside(ignoredDirectory), 0);

		const syncResults = globbySync(['**/*'], {cwd: repository, gitignore: true, fs: countingFs});
		t.deepEqual(syncResults.sort(), ['build', 'src/index.js']);
		t.is(countReadsInside(ignoredDirectory), 0);

		const streamResults = await collectStream(['**/*'], {cwd: repository, gitignore: true, fs: countingFs});
		t.deepEqual(streamResults.sort(), ['build', 'src/index.js']);
		t.is(countReadsInside(ignoredDirectory), 0);
	} finally {
		fs.rmSync(repository, {recursive: true, force: true});
	}
});

for (const [title, gitignore, files] of [
	[
		'anchored directory-only rule /build/',
		'/build/\n',
		{
			build: '',
			'src/build/keep.js': '',
		},
	],
	[
		'explicit globstar directory-only rule **/build/',
		'**/build/\n',
		{
			build: '',
			'sub/build': '',
			'pkg/build/ignored.js': '',
		},
	],
	[
		'subpath directory-only rule sub/build/',
		'sub/build/\n',
		{
			build: '',
			'sub/build': '',
			'other/sub/build/keep.js': '',
		},
	],
	[
		'wildcard ? directory-only rule bui?d/',
		'bui?d/\n',
		{
			build: '',
			bui1d: '',
			'nested/bui2d/ignored.js': '',
			'src/index.js': '',
		},
	],
	[
		'character-class directory-only rule [bc]ache/',
		'[bc]ache/\n',
		{
			cache: '',
			bache: '',
			'nested/cache/ignored.js': '',
			'src/index.js': '',
		},
	],
	[
		'anchored mid-globstar directory-only rule src/**/cache/',
		'src/**/cache/\n',
		{
			cache: '',
			'src/cache': '',
			'src/a/cache': '',
			'src/b/cache/ignored.js': '',
			'src/index.js': '',
		},
	],
	[
		'trailing globstar contents rule build/**',
		'build/**\n',
		{
			build: '',
			'sub/build/keep.js': '',
			'src/index.js': '',
		},
	],
	[
		'unanchored globstar contents rule **/build/**',
		'**/build/**\n',
		{
			build: '',
			'sub/build': '',
			'pkg/build/ignored.js': '',
			'src/index.js': '',
		},
	],
	[
		'nested subdir-only rule foo/**/',
		'foo/**/\n',
		{
			'foo/bar': '',
			'foo/sub/ignored.js': '',
		},
	],
]) {
	test(`matches git ls-files with matching regular files: ${title}`, async t => {
		const repository = createFixture({
			'.gitignore': gitignore,
			...files,
		}, {initGit: true});

		try {
			const expected = getGitFiles(repository);
			const options = {
				cwd: repository,
				dot: true,
				gitignore: true,
				ignore: ['.git'],
			};
			const asyncResults = await globby(['**/*'], options);
			const syncResults = globbySync(['**/*'], options);
			const streamResults = await collectStream(['**/*'], options);

			t.deepEqual(asyncResults.sort(), expected);
			t.deepEqual(syncResults.sort(), expected);
			t.deepEqual(streamResults.sort(), expected);
		} finally {
			fs.rmSync(repository, {recursive: true, force: true});
		}
	});
}

test('onlyFiles: false keeps regular file and excludes directory for directory-only rules, while keeping empty dir for /** rules', async t => {
	const repository = createFixture({
		'.gitignore': 'build/\ncache/**\n',
		build: '',
		'nested/build/out.js': '',
		'cache/ignored.js': '',
		'src/index.js': '',
	});

	try {
		const {fs: countingFs, countReadsInside} = createReaddirCountingFs();
		const cacheDirectory = path.join(repository, 'cache');
		const nestedBuildDirectory = path.join(repository, 'nested', 'build');
		const options = {
			cwd: repository,
			gitignore: true,
			onlyFiles: false,
			fs: countingFs,
		};

		const expected = ['build', 'cache', 'nested', 'src', 'src/index.js'];
		const asyncResults = await globby(['**/*'], options);
		t.deepEqual(asyncResults.sort(), expected);
		// `cache/**` still allows ignore-file search to look inside `cache/` for nested `.gitignore`, so it is read once during ignore discovery and skipped during the file glob itself.
		t.is(countReadsInside(cacheDirectory), 1);

		const syncResults = globbySync(['**/*'], options);
		t.deepEqual(syncResults.sort(), expected);
		t.is(countReadsInside(cacheDirectory), 2);
		t.is(countReadsInside(nestedBuildDirectory), 0);
	} finally {
		fs.rmSync(repository, {recursive: true, force: true});
	}
});

test('stats: true and objectMode: true with context-aware fs preserve regular files matching directory rules', async t => {
	const repository = createFixture({
		'.gitignore': 'build/\n',
		build: 'file',
		'src/index.js': '',
		'src/build/out.js': '',
	});

	try {
		const contextFs = createContextAwareFs();

		for (const extraOptions of [
			{stats: true, fs: contextFs},
			{objectMode: true, fs: contextFs},
		]) {
			const options = {cwd: repository, gitignore: true, ...extraOptions};
			// eslint-disable-next-line no-await-in-loop
			const asyncResults = await globby(['**/*'], options);
			const syncResults = globbySync(['**/*'], options);
			// eslint-disable-next-line no-await-in-loop
			const streamResults = await collectStream(['**/*'], options);

			const toPaths = results => results.map(entry => entry.path).sort();

			t.deepEqual(toPaths(asyncResults), ['build', 'src/index.js']);
			t.deepEqual(toPaths(syncResults), ['build', 'src/index.js']);
			t.deepEqual(toPaths(streamResults), ['build', 'src/index.js']);
		}
	} finally {
		fs.rmSync(repository, {recursive: true, force: true});
	}
});

test('direct glob inside anchored ignored directory still skips enumerating subdirectories', async t => {
	const repository = createFixture({
		'.gitignore': '/dist/\n',
		'dist/sub/out.js': '',
	});

	try {
		const {fs: countingFs, countReadsInside} = createReaddirCountingFs();
		const distDirectory = path.join(repository, 'dist');

		t.deepEqual(await globby(['dist/sub/**'], {cwd: repository, gitignore: true, fs: countingFs}), []);
		t.is(countReadsInside(distDirectory), 0);

		t.deepEqual(globbySync(['dist/sub/**'], {cwd: repository, gitignore: true, fs: countingFs}), []);
		t.is(countReadsInside(distDirectory), 0);
	} finally {
		fs.rmSync(repository, {recursive: true, force: true});
	}
});

test('nested gitignore and subdirectory cwd keep files and respect parent-directory boundaries', async t => {
	const repository = createFixture({
		'.gitignore': 'build/\n',
		'packages/app/.gitignore': 'local/\n',
		'packages/app/build': 'app-build-file\n',
		'packages/app/src/build/out.js': '',
		'packages/app/src/index.js': '',
		'packages/shared/local/keep.js': '',
		'packages/shared/build': 'shared-build-file\n',
		'packages/shared/out/build/ignored.js': '',
	});

	try {
		const appDirectory = path.join(repository, 'packages', 'app');
		const options = {cwd: appDirectory, gitignore: true};

		const asyncResults = await globby(['**/*'], options);
		const syncResults = globbySync(['**/*'], options);
		t.deepEqual(asyncResults.sort(), ['build', 'src/index.js']);
		t.deepEqual(syncResults.sort(), ['build', 'src/index.js']);

		// Parent-directory glob stays accurate for `packages/shared`: local/ in app's gitignore does not hide shared/local/keep.js, and root build/ still drops out/build/ignored.js while keeping file `shared/build`.
		const parentAsyncResults = await globby(['../shared/**/*'], options);
		const parentSyncResults = globbySync(['../shared/**/*'], options);
		t.deepEqual(parentAsyncResults.sort(), ['../shared/build', '../shared/local/keep.js']);
		t.deepEqual(parentSyncResults.sort(), ['../shared/build', '../shared/local/keep.js']);
	} finally {
		fs.rmSync(repository, {recursive: true, force: true});
	}
});

test('ignoreFiles still discovers regular ignore file whose name matches a directory-only rule', async t => {
	const repository = createFixture({
		'.gitignore': 'build/\n',
		build: 'ignored.txt\n',
		'keep.txt': '',
		'ignored.txt': '',
		'sub/build/.gitignore': '!ignored.txt\n',
	});

	try {
		const options = {cwd: repository, ignoreFiles: ['build', '**/.gitignore']};
		const asyncResults = await globby(['*.txt'], options);
		const syncResults = globbySync(['*.txt'], options);
		t.deepEqual(asyncResults.sort(), ['keep.txt']);
		t.deepEqual(syncResults.sort(), ['keep.txt']);
	} finally {
		fs.rmSync(repository, {recursive: true, force: true});
	}
});

test('symlinks matching directory-only rules follow git semantics without traversing directory targets', async t => {
	const repository = createFixture({
		'.gitignore': 'linkdir/\nlinkfile/\n',
		'target-dir/inside.js': '',
		'target-file.txt': 'hello\n',
	});

	try {
		try {
			fs.symlinkSync(path.join(repository, 'target-dir'), path.join(repository, 'linkdir'), 'dir');
			fs.symlinkSync(path.join(repository, 'target-file.txt'), path.join(repository, 'linkfile'), 'file');
		} catch (error) {
			if (error?.code === 'EPERM' || error?.code === 'ENOTSUP') {
				t.pass('Symlink creation requires elevated permissions on this platform');
				return;
			}

			throw error;
		}

		const {fs: countingFs, countReadsInside} = createReaddirCountingFs({contextAware: false});
		const linkDirectory = path.join(repository, 'linkdir');

		const followedOptions = {
			cwd: repository,
			gitignore: true,
			followSymbolicLinks: true,
			fs: countingFs,
		};
		const followedAsync = await globby(['**/*'], followedOptions);
		const followedSync = globbySync(['**/*'], followedOptions);
		t.deepEqual(followedAsync.sort(), ['linkfile', 'target-dir/inside.js', 'target-file.txt']);
		t.deepEqual(followedSync.sort(), ['linkfile', 'target-dir/inside.js', 'target-file.txt']);

		const unfollowedOptions = {
			cwd: repository,
			gitignore: true,
			followSymbolicLinks: false,
			fs: countingFs,
		};
		const unfollowedAsync = await globby(['**/*'], unfollowedOptions);
		const unfollowedSync = globbySync(['**/*'], unfollowedOptions);
		t.deepEqual(unfollowedAsync.sort(), ['target-dir/inside.js', 'target-file.txt']);
		t.deepEqual(unfollowedSync.sort(), ['target-dir/inside.js', 'target-file.txt']);

		t.is(countReadsInside(linkDirectory), 0);
	} finally {
		fs.rmSync(repository, {recursive: true, force: true});
	}
});
