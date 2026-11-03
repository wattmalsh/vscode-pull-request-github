/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import gql from 'graphql-tag';
import * as vscode from 'vscode';
import { GitHubRef } from '../common/githubRef';
import { toDisposable } from '../common/lifecycle';
import Logger from '../common/logger';
import { PR_SETTINGS_NAMESPACE, PREFETCH_PR_AUTHORS } from '../common/settingKeys';
import { formatError } from '../common/utils';
import { GitHubRepository } from '../github/githubRepository';
import { PullRequestResponse } from '../github/graphql';
import { IGitHubRef, IRawFileChange, PullRequest } from '../github/interface';
import { compareCommits } from '../github/loggingOctokit';
import { PullRequestMetadata } from '../github/pullRequestGitHelper';
import { parseGraphQLPullRequest } from '../github/utils';

export interface CachedPullRequest extends PullRequestMetadata {
	item: PullRequest;
	mergeBase: string;
	files: IRawFileChange[];
}

interface SearchNode {
	number: number;
	updatedAt: string;
}

interface PullRequestSearchResponse {
	authored: { nodes: SearchNode[] };
	reviewing: { nodes: SearchNode[] };
}

const PREFETCH_INTERVAL_MS = 15 * 60 * 1000;
const MIN_PREFETCH_GAP_MS = 10 * 60 * 1000;
const UNLISTED_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

const SEARCH = gql`query PullRequestSearch($authored: String!, $reviewing: String!) {
	authored: search(first: 50, type: ISSUE, query: $authored) { nodes { ... on PullRequest { number updatedAt } } }
	reviewing: search(first: 50, type: ISSUE, query: $reviewing) { nodes { ... on PullRequest { number updatedAt } } }
}`;

function toGitHubRef(ref: IGitHubRef): GitHubRef {
	return new GitHubRef(ref.ref, ref.label, ref.sha, ref.repo.cloneUrl, ref.repo.owner, ref.repo.name, ref.repo.isInOrganization);
}

export class PullRequestCache {
	private static readonly ID = 'PullRequestCache';
	private readonly _folder: vscode.Uri;

	constructor(storageUri: vscode.Uri) {
		this._folder = vscode.Uri.joinPath(storageUri, 'pullRequests');
	}

	private repositoryPrefix(owner: string, repositoryName: string): string {
		return `${owner}.${repositoryName}.`.toLowerCase();
	}

	private fileName(metadata: PullRequestMetadata): string {
		return `${this.repositoryPrefix(metadata.owner, metadata.repositoryName)}${metadata.prNumber}.json`;
	}

	async get(metadata: PullRequestMetadata): Promise<CachedPullRequest | undefined> {
		try {
			const content = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this._folder, this.fileName(metadata)));
			return JSON.parse(new TextDecoder().decode(content));
		} catch {
			return undefined;
		}
	}

	async set(cached: CachedPullRequest): Promise<void> {
		await vscode.workspace.fs.createDirectory(this._folder);
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this._folder, this.fileName(cached)), new TextEncoder().encode(JSON.stringify(cached)));
	}

	startPrefetching(gitHubRepositories: () => GitHubRepository[]): vscode.Disposable {
		const prefetchAll = () => gitHubRepositories().forEach(githubRepository => this.prefetch(githubRepository));
		prefetchAll();
		const timer = setInterval(prefetchAll, PREFETCH_INTERVAL_MS);
		return toDisposable(() => clearInterval(timer));
	}

	async prefetch(githubRepository: GitHubRepository): Promise<void> {
		const { owner, repositoryName } = githubRepository.remote;
		const prefix = this.repositoryPrefix(owner, repositoryName);
		const stamp = vscode.Uri.joinPath(this._folder, `${prefix}prefetched`);
		const lastPrefetch = await vscode.workspace.fs.stat(stamp).then(stat => stat.mtime, () => 0);
		if (Date.now() - lastPrefetch < MIN_PREFETCH_GAP_MS) {
			return;
		}

		try {
			await vscode.workspace.fs.createDirectory(this._folder);
			await vscode.workspace.fs.writeFile(stamp, new Uint8Array());
			const { query, schema, remote, octokit } = await githubRepository.ensure();
			const authors = ['@me', ...vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<string[]>(PREFETCH_PR_AUTHORS, [])];
			const scope = `repo:${owner}/${repositoryName} is:pr is:open`;
			const { data } = await query<PullRequestSearchResponse>({
				query: SEARCH,
				variables: {
					authored: `${scope} ${authors.map(author => `author:${author}`).join(' ')}`,
					reviewing: `${scope} user-review-requested:@me`,
				},
			});
			if (!data) {
				return;
			}

			const listed = new Set<string>();
			let fetched = 0;
			for (const { number, updatedAt } of [...data.authored.nodes, ...data.reviewing.nodes]) {
				const metadata: PullRequestMetadata = { owner, repositoryName, prNumber: number };
				const fileName = this.fileName(metadata);
				if (listed.has(fileName)) {
					continue;
				}
				listed.add(fileName);
				const cached = await this.get(metadata);
				if (cached?.item.updatedAt === updatedAt) {
					continue;
				}
				const { data: pullRequestData } = await query<PullRequestResponse>({
					query: schema.PullRequest,
					variables: { owner, name: repositoryName, number },
				});
				if (!pullRequestData?.repository) {
					continue;
				}
				const item = await parseGraphQLPullRequest(pullRequestData.repository.pullRequest, githubRepository);
				if (!item.head || !item.base) {
					continue;
				}
				fetched++;
				if (cached && cached.item.head?.sha === item.head.sha && cached.item.base?.ref === item.base.ref) {
					await this.set({ ...cached, item });
					continue;
				}
				const base = toGitHubRef(item.base);
				const { files, mergeBaseSha } = await compareCommits(remote, octokit, base, toGitHubRef(item.head), base.sha, item.number, PullRequestCache.ID);
				await this.set({ ...metadata, item, mergeBase: mergeBaseSha, files });
			}
			Logger.appendLine(`Prefetched ${listed.size} pull requests for ${owner}/${repositoryName}, ${fetched} updated`, PullRequestCache.ID);
			await this.removeExpired(prefix, listed);
		} catch (e) {
			Logger.warn(`Failed to prefetch pull requests for ${owner}/${repositoryName}: ${formatError(e)}`, PullRequestCache.ID);
		}
	}

	private async removeExpired(prefix: string, listed: Set<string>): Promise<void> {
		for (const [name] of await vscode.workspace.fs.readDirectory(this._folder)) {
			if (!name.startsWith(prefix) || !name.endsWith('.json') || listed.has(name)) {
				continue;
			}
			const uri = vscode.Uri.joinPath(this._folder, name);
			const { mtime } = await vscode.workspace.fs.stat(uri);
			if (Date.now() - mtime > UNLISTED_EXPIRY_MS) {
				await vscode.workspace.fs.delete(uri);
			}
		}
	}
}
