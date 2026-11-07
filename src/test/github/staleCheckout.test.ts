/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { Uri } from 'vscode';
import { Repository } from '../../api/api';
import { checkOutPullRequestHead } from '../../github/staleCheckout';

const ZERO = '0000000000000000000000000000000000000000';
const OLD = 'a'.repeat(40);
const AMENDED = 'b'.repeat(40);
const MINE = 'c'.repeat(40);

describe('checkOutPullRequestHead', function () {
	let root: string;
	let resetTo: string | undefined;

	beforeEach(function () {
		root = mkdtempSync(path.join(tmpdir(), 'stale-checkout-'));
		resetTo = undefined;
	});

	afterEach(function () {
		rmSync(root, { recursive: true, force: true });
	});

	function writeReflog(gitDir: string, shas: string[]) {
		const logDir = path.join(gitDir, 'logs', 'refs', 'remotes', 'origin');
		mkdirSync(logDir, { recursive: true });
		const lines = shas.map((sha, i) => `${i ? shas[i - 1] : ZERO} ${sha} Someone <s@example.com> 1700000000 +0000\tfetch: fast-forward`);
		writeFileSync(path.join(logDir, 'feature'), lines.join('\n') + '\n');
	}

	function createRepository(local: string, upstreamTip: string, ancestors: Record<string, string> = {}): Repository {
		return {
			rootUri: Uri.file(root),
			state: { HEAD: { name: 'feature', commit: local, upstream: { remote: 'origin', name: 'feature' } } },
			fetch: async () => { },
			getCommit: async () => ({ hash: upstreamTip }),
			getMergeBase: async (a: string, b: string) => ancestors[`${a}:${b}`] ?? 'unrelated',
			resetKeep: async (ref: string) => { resetTo = ref; },
		} as unknown as Repository;
	}

	it('moves to the head after the author force-pushes a commit this checkout fetched', async function () {
		writeReflog(path.join(root, '.git'), [OLD, AMENDED]);

		assert.equal(await checkOutPullRequestHead(createRepository(OLD, AMENDED), AMENDED), undefined);
		assert.equal(resetTo, AMENDED);
	});

	it('fast-forwards a branch that is behind', async function () {
		assert.equal(await checkOutPullRequestHead(createRepository(OLD, AMENDED, { [`${OLD}:${AMENDED}`]: OLD }), AMENDED), undefined);
		assert.equal(resetTo, AMENDED);
	});

	it('refuses when the branch has a commit that was never on the remote branch', async function () {
		writeReflog(path.join(root, '.git'), [OLD, AMENDED]);

		assert.equal(await checkOutPullRequestHead(createRepository(MINE, AMENDED), AMENDED), 'Branch feature has commits that were never on origin/feature.');
		assert.equal(resetTo, undefined);
	});

	it('reads the reflog from the common directory of a worktree', async function () {
		const common = path.join(root, 'main.git');
		const worktreeGitDir = path.join(common, 'worktrees', 'wt');
		mkdirSync(worktreeGitDir, { recursive: true });
		writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n');
		writeFileSync(path.join(root, '.git'), `gitdir: ${worktreeGitDir}\n`);
		writeReflog(common, [OLD, AMENDED]);

		assert.equal(await checkOutPullRequestHead(createRepository(OLD, AMENDED), AMENDED), undefined);
		assert.equal(resetTo, AMENDED);
	});

	it('refuses when the remote branch is not at the pull request head', async function () {
		assert.equal(await checkOutPullRequestHead(createRepository(OLD, OLD), AMENDED), `origin/feature is at aaaaaaa, not the pull request head bbbbbbb.`);
		assert.equal(resetTo, undefined);
	});
});
