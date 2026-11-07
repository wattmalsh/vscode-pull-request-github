/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { Repository } from '../api/api';

async function readText(uri: vscode.Uri): Promise<string | undefined> {
	try {
		return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)).trim();
	} catch {
		return undefined;
	}
}

export async function refHistory(rootUri: vscode.Uri, ref: string): Promise<string[]> {
	let gitDir = vscode.Uri.joinPath(rootUri, '.git');
	try {
		if ((await vscode.workspace.fs.stat(gitDir)).type === vscode.FileType.File) {
			const pointer = await readText(gitDir);
			if (!pointer) {
				return [];
			}
			gitDir = vscode.Uri.file(path.resolve(rootUri.fsPath, pointer.replace(/^gitdir:\s*/, '')));
		}
	} catch {
		return [];
	}
	const commonDir = await readText(vscode.Uri.joinPath(gitDir, 'commondir'));
	const logDir = commonDir ? vscode.Uri.file(path.resolve(gitDir.fsPath, commonDir)) : gitDir;
	const log = await readText(vscode.Uri.joinPath(logDir, 'logs', ref));
	if (!log) {
		return [];
	}
	return log.split('\n').map(line => line.split(' ')[1]).filter(sha => sha && !/^0+$/.test(sha)).reverse();
}

async function isAncestor(repository: Repository, commit: string, of: string): Promise<boolean> {
	if (commit === of) {
		return true;
	}
	try {
		return await repository.getMergeBase(commit, of) === commit;
	} catch {
		return false;
	}
}

export async function checkOutPullRequestHead(repository: Repository, headSha: string): Promise<string | undefined> {
	const head = repository.state.HEAD;
	if (!head?.name || !head.commit) {
		return vscode.l10n.t('The checkout is not on a branch.');
	}
	if (!head.upstream) {
		return vscode.l10n.t('Branch {0} does not track a remote branch.', head.name);
	}
	if (!repository.resetKeep) {
		return vscode.l10n.t('This version of VS Code cannot move the branch.');
	}
	const upstreamName = `${head.upstream.remote}/${head.upstream.name}`;
	await repository.fetch(head.upstream.remote, head.upstream.name);
	const upstreamCommit = (await repository.getCommit(`refs/remotes/${upstreamName}`)).hash;
	if (upstreamCommit !== headSha) {
		return vscode.l10n.t('{0} is at {1}, not the pull request head {2}.', upstreamName, upstreamCommit.substring(0, 7), headSha.substring(0, 7));
	}
	const history = new Set([upstreamCommit, ...await refHistory(repository.rootUri, `refs/remotes/${upstreamName}`)]);
	for (const sha of history) {
		if (await isAncestor(repository, head.commit, sha)) {
			await repository.resetKeep(headSha);
			return undefined;
		}
	}
	return vscode.l10n.t('Branch {0} has commits that were never on {1}.', head.name, upstreamName);
}
