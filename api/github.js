import { Octokit } from '@octokit/rest';

const COMMIT_LIMIT_PER_BRANCH = 22;
const DEFAULT_BRANCH_LIMIT = 12;
const HAS_GITHUB_TOKEN = Boolean(process.env.GITHUB_TOKEN);
const MAX_BRANCH_LIMIT = HAS_GITHUB_TOKEN ? 50 : 20;
const RECENT_BRANCH_POOL = 80;
const PALETTE = [
  '#1f77b4',
  '#d62728',
  '#2ca02c',
  '#9467bd',
  '#ff7f0e',
  '#17becf',
  '#8c564b',
  '#e377c2',
  '#bcbd22',
  '#7f7f7f',
  '#2f4b7c',
  '#a05195',
];

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN || undefined,
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseGitHubRepoUrl(value) {
  const trimmed = String(value || '').trim().replace(/\.git$/, '');
  const match = trimmed.match(/github\.com[:/](?<owner>[^/\s]+)\/(?<repo>[^/#?\s]+)/i);
  if (!match?.groups) return null;
  return {
    owner: match.groups.owner,
    repo: match.groups.repo,
  };
}

function makeEdgeKey(source, target, branchName) {
  return `${source}->${target}:${branchName}`;
}

function getContributorName(commit) {
  return (
    commit.author?.login ||
    commit.commit?.author?.name ||
    commit.commit?.committer?.name ||
    'Unknown'
  );
}

function buildGraph(branches, defaultBranchName) {
  const nodeMap = new Map();
  const edgeMap = new Map();

  branches.forEach((branch) => {
    branch.commits.forEach((commit, index) => {
      const existing = nodeMap.get(commit.sha);
      const branchNames = new Set(existing?.branches || []);
      branchNames.add(branch.name);
      const primaryBranch = existing?.primaryBranch || branch.name;

      nodeMap.set(commit.sha, {
        ...existing,
        id: commit.sha,
        sha: commit.sha,
        branches: [...branchNames],
        primaryBranch,
        message: commit.commit?.message?.split('\n')[0] || 'No commit message',
        author: getContributorName(commit),
        avatar: commit.author?.avatar_url,
        date: commit.commit?.author?.date || commit.commit?.committer?.date,
        url: commit.html_url,
        branchDepth: Math.min(existing?.branchDepth ?? Number.POSITIVE_INFINITY, index),
        parents: commit.parents?.map((parent) => parent.sha) || [],
      });

      commit.parents?.forEach((parent) => {
        const key = makeEdgeKey(parent.sha, commit.sha, branch.name);
        if (!edgeMap.has(key)) {
          edgeMap.set(key, {
            id: key,
            source: parent.sha,
            target: commit.sha,
            branch: branch.name,
            defaultBranch: branch.name === defaultBranchName,
          });
        }
      });
    });
  });

  const nodes = [...nodeMap.values()]
    .map((node) => ({
      ...node,
      branchScore: node.branches.includes(defaultBranchName) ? 0 : node.branchDepth + 1,
    }))
    .sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));

  const validNodeIds = new Set(nodes.map((node) => node.id));
  const links = [...edgeMap.values()].filter(
    (link) => validNodeIds.has(link.source) && validNodeIds.has(link.target),
  );

  return { nodes, links };
}

function chooseDisplayedBranches(branches, defaultBranchName, branchLimit) {
  const requested = clamp(branchLimit, 2, MAX_BRANCH_LIMIT);
  const defaultBranch = branches.find((branch) => branch.name === defaultBranchName);
  const withoutDefault = branches.filter((branch) => branch.name !== defaultBranchName);
  const selected = defaultBranch
    ? [defaultBranch, ...withoutDefault.slice(0, requested - 1)]
    : withoutDefault.slice(0, requested);

  return selected.slice(0, requested);
}

async function listRecentBranchSummaries(owner, repo, defaultBranchName, branchLimit) {
  const queryLimit = clamp(Math.max(branchLimit + 8, RECENT_BRANCH_POOL), branchLimit, 100);

  try {
    const response = await octokit.graphql(
      `
        query RecentBranches($owner: String!, $repo: String!, $count: Int!) {
          repository(owner: $owner, name: $repo) {
            refs(
              refPrefix: "refs/heads/"
              first: $count
              orderBy: { field: TAG_COMMIT_DATE, direction: DESC }
            ) {
              totalCount
              nodes {
                name
                target {
                  ... on Commit {
                    oid
                    committedDate
                  }
                }
              }
            }
          }
        }
      `,
      {
        owner,
        repo,
        count: queryLimit,
      },
    );

    const branches = response.repository.refs.nodes.map((branch) => ({
      name: branch.name,
      sha: branch.target?.oid,
      committedDate: branch.target?.committedDate,
      protected: false,
    }));

    if (!branches.some((branch) => branch.name === defaultBranchName)) {
      const defaultBranch = await octokit.rest.repos.getBranch({
        owner,
        repo,
        branch: defaultBranchName,
      });

      branches.unshift({
        name: defaultBranch.data.name,
        sha: defaultBranch.data.commit.sha,
        protected: defaultBranch.data.protected,
        committedDate: null,
      });
    }

    return {
      totalCount: response.repository.refs.totalCount,
      branches,
    };
  } catch {
    const branches = await octokit.paginate(octokit.rest.repos.listBranches, {
      owner,
      repo,
      per_page: 100,
    });
    const mapped = branches.map((branch) => ({
      name: branch.name,
      sha: branch.commit.sha,
      protected: branch.protected,
      committedDate: null,
    }));
    mapped.sort((first, second) => (
      Number(second.name === defaultBranchName) - Number(first.name === defaultBranchName)
      || first.name.localeCompare(second.name)
    ));

    return {
      totalCount: mapped.length,
      branches: mapped,
    };
  }
}

async function loadRepository(repoUrl, requestedBranchLimit = DEFAULT_BRANCH_LIMIT) {
  const parsed = parseGitHubRepoUrl(repoUrl);
  if (!parsed) {
    const error = new Error('Paste a valid GitHub repository URL, such as https://github.com/facebook/react.');
    error.status = 400;
    throw error;
  }

  const branchLimit = clamp(Number(requestedBranchLimit) || DEFAULT_BRANCH_LIMIT, 2, MAX_BRANCH_LIMIT);
  const { owner, repo } = parsed;
  const repository = await octokit.rest.repos.get({ owner, repo });
  const defaultBranchName = repository.data.default_branch;
  const branchSummaries = await listRecentBranchSummaries(owner, repo, defaultBranchName, branchLimit);
  const sortedBranches = chooseDisplayedBranches(branchSummaries.branches, defaultBranchName, branchLimit);

  const branches = await Promise.all(
    sortedBranches.map(async (branch, index) => {
      const [commitsResponse, compareResponse] = await Promise.all([
        octokit.rest.repos.listCommits({
          owner,
          repo,
          sha: branch.name,
          per_page: COMMIT_LIMIT_PER_BRANCH,
        }),
        branch.name === defaultBranchName
          ? Promise.resolve({ data: { ahead_by: 0, behind_by: 0, files: [] } })
          : octokit.rest.repos.compareCommitsWithBasehead({
              owner,
              repo,
              basehead: `${defaultBranchName}...${branch.name}`,
            }).catch(() => ({ data: { ahead_by: 0, behind_by: 0, files: [] } })),
      ]);

      return {
        name: branch.name,
        sha: branch.sha || commitsResponse.data[0]?.sha,
        protected: branch.protected || false,
        committedDate: branch.committedDate,
        baseColor: PALETTE[index % PALETTE.length],
        commits: commitsResponse.data,
        aheadBy: compareResponse.data.ahead_by || 0,
        behindBy: compareResponse.data.behind_by || 0,
        changedFiles: compareResponse.data.files || [],
      };
    }),
  );

  return {
    owner,
    repo,
    repository: repository.data,
    defaultBranchName,
    availableBranchCount: branchSummaries.totalCount,
    loadedBranchCount: sortedBranches.length,
    branchLimit,
    maxBranchLimit: MAX_BRANCH_LIMIT,
    hasServerToken: HAS_GITHUB_TOKEN,
    branches,
    graph: buildGraph(branches, defaultBranchName),
  };
}

async function loadCommitDetails(owner, repo, sha) {
  if (!owner || !repo || !sha) {
    const error = new Error('Missing owner, repo, or sha.');
    error.status = 400;
    throw error;
  }

  const response = await octokit.rest.repos.getCommit({
    owner,
    repo,
    ref: sha,
  });
  return response.data;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const { action } = req.query;

    if (action === 'repository') {
      const data = await loadRepository(req.query.repoUrl, req.query.branchLimit);
      return res.status(200).json(data);
    }

    if (action === 'commit') {
      const data = await loadCommitDetails(req.query.owner, req.query.repo, req.query.sha);
      return res.status(200).json(data);
    }

    return res.status(400).json({ error: 'Unknown GitHub proxy action.' });
  } catch (error) {
    return res.status(error.status || 500).json({
      error: error.message || 'GitHub request failed.',
    });
  }
}
