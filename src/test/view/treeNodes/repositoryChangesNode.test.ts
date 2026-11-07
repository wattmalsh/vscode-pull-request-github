/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { BaseTreeNode, TreeNode } from '../../../view/treeNodes/treeNode';
import { RepositoryChangesNode, StaleCheckoutNode } from '../../../view/treeNodes/repositoryChangesNode';

function disposable(): vscode.Disposable {
	return { dispose: () => { } };
}

describe('RepositoryChangesNode', function () {
	function createNode(localCommit: string, headSha: string): RepositoryChangesNode {
		const parent: BaseTreeNode = {
			reveal: async () => { },
			refresh: () => { },
			children: undefined,
			view: {
				visible: true,
				onDidChangeVisibility: () => disposable(),
			} as unknown as vscode.TreeView<TreeNode>,
		};
		const pullRequestModel = {
			title: 'Pull request title',
			number: 1,
			author: { avatarUrl: '' },
			remote: { owner: 'owner', repositoryName: 'repository' },
			item: { isRemoteHeadDeleted: false },
			hasChangesSinceLastReview: false,
			showChangesSinceReview: false,
			onDidChange: () => disposable(),
			onDidChangeReviewThreads: () => disposable(),
			onDidChangeFileViewedState: () => disposable(),
			equals: () => true,
			head: { sha: headSha },
		};
		const folderRepositoryManager = {
			repository: { state: { HEAD: { commit: localCommit }, onDidChange: () => disposable() } },
			context: {},
			activePullRequest: pullRequestModel,
			isPullRequestAssociatedWithOpenRepository: () => true,
		};
		const reviewModel = {
			onDidChangeLocalFileChanges: () => disposable(),
		};
		return new RepositoryChangesNode(
			parent,
			pullRequestModel as any,
			folderRepositoryManager as any,
			reviewModel as any,
			{ progress: Promise.resolve() } as any,
		);
	}

	// Verifies that VS Code can resolve the visible category nodes through their rendered parent chain.
	it('parents the category nodes to the repository changes node', async function () {
		const node = createNode('abc1234def', 'abc1234def');
		let children: TreeNode[] = [];

		try {
			children = await node.getChildren();
			const [filesNode, commitsNode] = children;
			assert.strictEqual(filesNode.getParent(), node);
			assert.strictEqual(commitsNode.getParent(), node);
		} finally {
			children.forEach(child => child.dispose());
			node.dispose();
		}
	});

	it('shows a warning row first when the checkout is not the pull request head', async function () {
		const node = createNode('f7319917986aaaa', 'c439467d484bbbb');
		let children: TreeNode[] = [];

		try {
			children = await node.getChildren();
			assert.strictEqual(children.length, 3);
			assert.ok(children[0] instanceof StaleCheckoutNode);
			assert.strictEqual((await children[0].getTreeItem()).label, 'Local f731991 is not pull request head c439467');
		} finally {
			children.forEach(child => child.dispose());
			node.dispose();
		}
	});

	it('shows no warning row when the checkout is the pull request head', async function () {
		const node = createNode('c439467d484bbbb', 'c439467d484bbbb');
		let children: TreeNode[] = [];

		try {
			children = await node.getChildren();
			assert.strictEqual(children.length, 2);
			assert.ok(!children.some(child => child instanceof StaleCheckoutNode));
		} finally {
			children.forEach(child => child.dispose());
			node.dispose();
		}
	});
});
