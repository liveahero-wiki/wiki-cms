import { GitHubError, clearInstallationToken, githubClient, githubConfig, type GitHubClient, type PullRequest } from '../../core/github-app.ts'
import type { ApproveResult, HookRow } from '../../core/types-registry.ts'
import type { Env } from '../../env.ts'
import { joinFrontMatter, splitFrontMatter } from './frontmatter.ts'
import { validatePageEdit } from './validate.ts'

export const PR_LABEL = 'community-edit'

export const CONFLICT_LABEL = 'The page changed since the contributor started editing; edit "after" and set baseSha to the current file blob sha'

/** Name for a `Co-authored-by` trailer: no angle brackets, no line breaks, bounded. */
export function trailerName(displayName: string): string {
  const clean = displayName
    .replace(/[\p{Cc}\p{Zl}\p{Zp}<>]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64)
    .trim()
  return clean || 'Contributor'
}

export function commitMessage(summary: string, submissionId: string, owner: HookRow['owner']): string {
  const lines = [summary, '', `Submitted via wiki-cms #${submissionId.slice(0, 8)}`]
  if (owner) lines.push('', `Co-authored-by: ${trailerName(owner.displayName)} <contrib-${owner.id.replace(/[^A-Za-z0-9_-]/g, '-')}@users.invalid>`)
  return lines.join('\n')
}

export function pullRequestBody(path: string, submissionId: string): string {
  return [
    `Submitted through the wiki editor (wiki-cms submission \`${submissionId}\`).`,
    '',
    `- Page: \`${path}\``,
    '',
    'A maintainer must review this change before it is merged. The `build-and-test` and `contrib-guard` checks must pass; nothing merges this pull request automatically.',
  ].join('\n')
}

const fail = (status: 400 | 409 | 500 | 502, code: string, message: string, external?: unknown): ApproveResult => ({ ok: false, status, code, message, ...(external === undefined ? {} : { external }) })

/** The open PR for `input.head`, created (and labelled) when there is none. */
async function openPullRequest(client: GitHubClient, env: Env, input: { title: string; head: string; base: string; body: string }): Promise<PullRequest> {
  const open = await client.findOpenPullRequest(input.head)
  if (open) return open
  let created: PullRequest
  try {
    created = await client.createPullRequest(input)
  } catch (e) {
    // A concurrent approval opened it between the lookup and the create.
    if (e instanceof GitHubError && e.status === 422) {
      const raced = await client.findOpenPullRequest(input.head)
      if (raced) return raced
    }
    throw e
  }
  // Labels are a convenience; the pull request exists either way (never add the preview label unless an operator configured it).
  const labels = [PR_LABEL, ...(env.GITHUB_PREVIEW_LABEL?.trim() ? [env.GITHUB_PREVIEW_LABEL.trim()] : [])]
  await client.addLabels(created.number, labels).catch(() => {})
  return created
}

/** Turns an approved page edit into (or updates) a pull request through the GitHub App. Never merges. */
export async function approvePageEdit(env: Env, row: HookRow, now: number): Promise<ApproveResult> {
  const cfg = githubConfig(env)
  if (!cfg.ok) return fail(500, 'github_not_configured', `The GitHub App is not configured on the Worker (missing: ${cfg.missing.join(', ')}).`)
  const { config } = cfg

  const parsed = validatePageEdit(row.payload)
  if (!parsed.ok) return fail(400, 'bad_payload', 'The stored page edit is not valid; edit it before approving.')
  const edit = parsed.value
  const branch = `contrib/${row.id}`

  let client: GitHubClient
  try {
    client = await githubClient(env, config, now)
  } catch (e) {
    if (e instanceof GitHubError) return fail(502, 'github_error', `Could not get a GitHub installation token: ${e.message}`)
    return fail(500, 'github_not_configured', e instanceof Error ? e.message : 'The GitHub App key could not be used.')
  }

  try {
    // (a) the file as it is on master now
    const current = await client.getFile(edit.path, config.baseBranch)
    if (!current) {
      return fail(409, 'base_conflict', `${edit.path} no longer exists on ${config.baseBranch}.`, { outcome: { status: 'conflict', label: `${edit.path} no longer exists on ${config.baseBranch}` } })
    }

    // (b) same blob, or only the front matter changed since the contributor started: fine. A different body is a conflict.
    if (current.sha !== edit.baseSha) {
      let base: string | null = null
      try {
        base = await client.getBlob(edit.baseSha)
      } catch (e) {
        if (!(e instanceof GitHubError && (e.status === 404 || e.status === 422))) throw e
      }
      if (base === null || splitFrontMatter(base).body !== splitFrontMatter(current.text).body) {
        return fail(409, 'base_conflict', 'The page changed since the contributor started editing. Edit "after" against the current page and set baseSha to the current blob sha.', {
          outcome: { status: 'conflict', label: CONFLICT_LABEL },
          currentSha: current.sha,
        })
      }
    }

    // (c) current front matter + the edited body
    const text = joinFrontMatter(splitFrontMatter(current.text).frontMatter, edit.after)
    if (text === current.text) return fail(400, 'no_change', 'This edit makes no change to the page; reject it instead.')

    // (d) branch (new, or the existing one for a re-approval) and pull request
    const head = await client.getBranchHead(config.baseBranch)
    if (!head) return fail(502, 'github_error', `Branch ${config.baseBranch} was not found.`)
    const existing = await client.getBranchHead(branch)
    const blob = await client.createBlob(text)
    const tree = await client.createTree(await client.getCommitTree(head), edit.path, blob)
    // An existing branch is fast-forwarded with a commit that also merges the current base, so the PR diff is always just this file.
    const parents = existing && existing !== head ? [existing, head] : [head]
    const commit = await client.createCommit(commitMessage(edit.summary, row.id, row.owner), tree, parents)
    if (existing) await client.updateRef(branch, commit)
    else await client.createRef(branch, commit)

    // Ask GitHub rather than trusting `row.external`: an earlier approval may have opened the PR and then lost its save.
    const pr = await openPullRequest(client, env, { title: edit.summary, head: branch, base: config.baseBranch, body: pullRequestBody(edit.path, row.id) })

    return {
      ok: true,
      external: {
        outcome: { status: 'pr_open', url: pr.url, label: `Pull request #${pr.number} is open for review` },
        pr: { number: pr.number, branch, url: pr.url },
      },
    }
  } catch (e) {
    if (e instanceof GitHubError) {
      if (e.status === 401) await clearInstallationToken(env).catch(() => {})
      return fail(502, 'github_error', e.message)
    }
    throw e
  }
}
