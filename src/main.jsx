import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Octokit } from '@octokit/rest';
import * as d3 from 'd3';
import {
  AlertTriangle,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Loader2,
  PanelRightClose,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import './styles.css';

const COMMIT_LIMIT_PER_BRANCH = 22;
const BRANCH_LIMIT = 12;
const LANE_WIDTH = 112;
const ROW_HEIGHT = 72;
const GRAPH_LEFT_PADDING = 130;
const GRAPH_TOP_PADDING = 92;
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
  auth: import.meta.env.VITE_GITHUB_TOKEN || undefined,
});

function parseGitHubRepoUrl(value) {
  const trimmed = value.trim().replace(/\.git$/, '');
  const match = trimmed.match(/github\.com[:/](?<owner>[^/\s]+)\/(?<repo>[^/#?\s]+)/i);
  if (!match?.groups) return null;
  return {
    owner: match.groups.owner,
    repo: match.groups.repo,
  };
}

function shortSha(sha = '') {
  return sha.slice(0, 7);
}

function formatDate(value) {
  if (!value) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mixWithGray(hexColor, amount) {
  return d3.interpolateRgb(hexColor, '#8f949d')(clamp(amount, 0, 0.82));
}

function getBranchColor(branch) {
  if (!branch) return '#64748b';
  const dullness = clamp((branch.behindBy || 0) / 80, 0, 0.78);
  return mixWithGray(branch.baseColor, dullness);
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

function summarizeBranch(branch) {
  const contributors = new Map();
  branch.commits.forEach((commit) => {
    const name = getContributorName(commit);
    contributors.set(name, (contributors.get(name) || 0) + 1);
  });
  return [...contributors.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
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

function createLaneLayout(graph, branches) {
  const branchLane = new Map(branches.map((branch, index) => [branch.name, index]));
  const branchCommitIndex = new Map();

  branches.forEach((branch) => {
    branch.commits.forEach((commit, index) => {
      branchCommitIndex.set(`${branch.name}:${commit.sha}`, index);
    });
  });

  const nodes = graph.nodes.map((node) => {
    const lane = branchLane.get(node.primaryBranch) ?? 0;
    const index = branchCommitIndex.get(`${node.primaryBranch}:${node.id}`) ?? node.branchDepth ?? 0;

    return {
      ...node,
      x: GRAPH_LEFT_PADDING + lane * LANE_WIDTH,
      y: GRAPH_TOP_PADDING + index * ROW_HEIGHT,
      lane,
    };
  });

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const links = graph.links
    .map((link) => ({
      ...link,
      source: nodeById.get(link.source),
      target: nodeById.get(link.target),
    }))
    .filter((link) => link.source && link.target);

  return { nodes, links };
}

function orthogonalPath(edge) {
  const { source, target } = edge;
  if (Math.abs(source.x - target.x) < 2) {
    return `M${source.x},${source.y}L${target.x},${target.y}`;
  }

  const turnY = target.y;
  return `M${source.x},${source.y}L${source.x},${turnY}L${target.x},${turnY}`;
}

async function loadRepository(repoUrl) {
  const parsed = parseGitHubRepoUrl(repoUrl);
  if (!parsed) {
    throw new Error('Paste a valid GitHub repository URL, such as https://github.com/facebook/react.');
  }

  const { owner, repo } = parsed;
  const repository = await octokit.rest.repos.get({ owner, repo });
  const defaultBranchName = repository.data.default_branch;

  const branchResponse = await octokit.rest.repos.listBranches({
    owner,
    repo,
    per_page: BRANCH_LIMIT,
  });

  const sortedBranches = branchResponse.data
    .sort((a, b) => Number(b.name === defaultBranchName) - Number(a.name === defaultBranchName))
    .slice(0, BRANCH_LIMIT);

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
        sha: branch.commit.sha,
        protected: branch.protected,
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
    branches,
    graph: buildGraph(branches, defaultBranchName),
  };
}

async function loadCommitDetails(repoData, sha) {
  const response = await octokit.rest.repos.getCommit({
    owner: repoData.owner,
    repo: repoData.repo,
    ref: sha,
  });
  return response.data;
}

function predictConflicts(firstBranch, secondBranch) {
  if (!firstBranch || !secondBranch) return null;

  const firstFiles = new Map(firstBranch.changedFiles.map((file) => [file.filename, file]));
  const secondFiles = new Map(secondBranch.changedFiles.map((file) => [file.filename, file]));
  const overlapping = [...firstFiles.keys()]
    .filter((fileName) => secondFiles.has(fileName))
    .map((fileName) => ({
      fileName,
      first: firstFiles.get(fileName),
      second: secondFiles.get(fileName),
    }));

  const deletedModified = overlapping.filter(({ first, second }) => {
    const statuses = new Set([first.status, second.status]);
    return statuses.has('removed') && statuses.size > 1;
  });

  const patchOverlap = overlapping.filter(({ first, second }) => {
    const firstPatch = first.patch || '';
    const secondPatch = second.patch || '';
    return firstPatch && secondPatch && firstPatch.slice(0, 120) !== secondPatch.slice(0, 120);
  });

  const score = clamp(
    overlapping.length * 15 + deletedModified.length * 30 + patchOverlap.length * 12,
    0,
    100,
  );

  const risk =
    score >= 70 ? 'High' : score >= 35 ? 'Medium' : overlapping.length > 0 ? 'Low' : 'Minimal';

  return {
    risk,
    score,
    overlapping,
    deletedModified,
    patchOverlap,
  };
}

function Header({ repoUrl, setRepoUrl, onLoad, loading, error, repoData }) {
  return (
    <header className="app-header">
      <div className="brand">
        <GitBranch size={24} aria-hidden="true" />
        <div>
          <h1>GitHub Branch Visualizer</h1>
          <p>{repoData ? `${repoData.owner}/${repoData.repo}` : 'Explore public repository branch DAGs'}</p>
        </div>
      </div>
      <form className="repo-form" onSubmit={onLoad}>
        <label className="repo-input">
          <Search size={18} aria-hidden="true" />
          <input
            value={repoUrl}
            onChange={(event) => setRepoUrl(event.target.value)}
            placeholder="https://github.com/vercel/next.js"
            aria-label="Public GitHub repository URL"
          />
        </label>
        <button className="primary-button" type="submit" disabled={loading}>
          {loading ? <Loader2 className="spin" size={18} aria-hidden="true" /> : <GitBranch size={18} aria-hidden="true" />}
          Load
        </button>
      </form>
      {error && <div className="error-banner">{error}</div>}
    </header>
  );
}

function Toolbar({ onZoomIn, onZoomOut, onReset, selectedBranches, onClearBranches }) {
  return (
    <div className="graph-toolbar" aria-label="Graph controls">
      <button type="button" onClick={onZoomIn} title="Zoom in" aria-label="Zoom in">
        <ZoomIn size={18} />
      </button>
      <button type="button" onClick={onZoomOut} title="Zoom out" aria-label="Zoom out">
        <ZoomOut size={18} />
      </button>
      <button type="button" onClick={onReset}>
        Reset View
      </button>
      {selectedBranches.length > 0 && (
        <button type="button" onClick={onClearBranches}>
          <X size={16} />
          Clear Branches
        </button>
      )}
    </div>
  );
}

function BranchLegend({ branches, selectedBranches, onToggleBranch }) {
  return (
    <aside className="legend-panel" aria-label="Branch legend">
      <div className="panel-kicker">Branches</div>
      <div className="legend-list">
        {branches.map((branch) => {
          const color = getBranchColor(branch);
          const selected = selectedBranches.includes(branch.name);
          return (
            <button
              key={branch.name}
              className={`legend-row ${selected ? 'selected' : ''}`}
              type="button"
              onClick={() => onToggleBranch(branch.name)}
            >
              <span className="branch-swatch" style={{ background: color }} />
              <span className="legend-name">{branch.name}</span>
              <span className="legend-meta">{branch.behindBy} behind</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function GraphCanvas({
  graph,
  branches,
  selectedCommits,
  selectedBranches,
  onToggleCommit,
  onToggleBranch,
  onNodeDetails,
}) {
  const svgRef = useRef(null);
  const wrapperRef = useRef(null);
  const zoomRef = useRef(null);
  const nodePositionsRef = useRef(new Map());
  const branchByName = useMemo(() => new Map(branches.map((branch) => [branch.name, branch])), [branches]);

  const applyZoom = useCallback((factor) => {
    const svg = d3.select(svgRef.current);
    if (zoomRef.current) {
      svg.transition().duration(240).call(zoomRef.current.scaleBy, factor);
    }
  }, []);

  const resetZoom = useCallback(() => {
    const svg = d3.select(svgRef.current);
    if (zoomRef.current) {
      svg.transition().duration(240).call(zoomRef.current.transform, d3.zoomIdentity);
    }
  }, []);

  useEffect(() => {
    if (!svgRef.current || !wrapperRef.current || !graph.nodes.length) return undefined;

    const wrapper = wrapperRef.current;
    const { width, height } = wrapper.getBoundingClientRect();
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${width} ${height}`);

    const root = svg.append('g').attr('class', 'graph-root');
    const linkLayer = root.append('g').attr('class', 'link-layer');
    const nodeLayer = root.append('g').attr('class', 'node-layer');

    const zoomBehavior = d3.zoom()
      .scaleExtent([0.25, 4])
      .on('zoom', (event) => {
        root.attr('transform', event.transform);
      });
    zoomRef.current = zoomBehavior;
    svg.call(zoomBehavior);

    const laneLayout = createLaneLayout(graph, branches);
    const nodes = laneLayout.nodes.map((node) => {
      const position = nodePositionsRef.current.get(node.id);
      return {
        ...node,
        x: position?.x ?? node.x,
        y: position?.y ?? node.y,
      };
    });
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const links = laneLayout.links.map((link) => ({
      ...link,
      source: nodeById.get(link.source.id),
      target: nodeById.get(link.target.id),
    }));

    const link = linkLayer
      .selectAll('path')
      .data(links)
      .join('path')
      .attr('class', (edge) => `graph-link ${selectedBranches.includes(edge.branch) ? 'selected' : ''}`)
      .attr('stroke', (edge) => getBranchColor(branchByName.get(edge.branch)))
      .attr('stroke-width', (edge) => (selectedBranches.includes(edge.branch) ? 5 : 3))
      .attr('d', orthogonalPath)
      .attr('fill', 'none')
      .attr('stroke-linecap', 'round')
      .attr('stroke-linejoin', 'round')
      .on('click', (event, edge) => {
        event.stopPropagation();
        onToggleBranch(edge.branch);
      });

    link.append('title').text((edge) => `Select branch ${edge.branch}`);

    const updateGraph = () => {
      link.attr('d', orthogonalPath);
      node.attr('transform', (commit) => `translate(${commit.x},${commit.y})`);
    };

    const node = nodeLayer
      .selectAll('g')
      .data(nodes)
      .join('g')
      .attr('class', (commit) => `graph-node ${selectedCommits.includes(commit.id) ? 'selected' : ''}`)
      .call(
        d3.drag()
          .on('start', (event, commit) => {
            d3.select(event.sourceEvent.target.closest('g')).raise();
            commit.x = event.x;
            commit.y = event.y;
            nodePositionsRef.current.set(commit.id, { x: commit.x, y: commit.y });
          })
          .on('drag', (event, commit) => {
            commit.x = event.x;
            commit.y = event.y;
            nodePositionsRef.current.set(commit.id, { x: commit.x, y: commit.y });
            updateGraph();
          })
          .on('end', (event, commit) => {
            commit.x = event.x;
            commit.y = event.y;
            nodePositionsRef.current.set(commit.id, { x: commit.x, y: commit.y });
            updateGraph();
          }),
      )
      .on('click', (event, commit) => {
        event.stopPropagation();
        onToggleCommit(commit.id);
        onNodeDetails(commit);
      });

    node
      .append('circle')
      .attr('r', (commit) => (selectedCommits.includes(commit.id) ? 13 : 10))
      .attr('fill', (commit) => getBranchColor(branchByName.get(commit.primaryBranch)))
      .attr('stroke', '#ffffff')
      .attr('stroke-width', 2.2);

    node
      .append('text')
      .attr('x', 15)
      .attr('y', 4)
      .text((commit) => shortSha(commit.sha));

    node.append('title').text((commit) => `${commit.message}\n${commit.author}`);

    nodes.forEach((commit) => {
      nodePositionsRef.current.set(commit.id, { x: commit.x, y: commit.y });
    });
    updateGraph();

    return () => {
      svg.on('.zoom', null);
    };
  }, [
    graph,
    branchByName,
    branches,
    onNodeDetails,
    onToggleBranch,
    onToggleCommit,
    selectedBranches,
    selectedCommits,
  ]);

  return (
    <section className="graph-section" ref={wrapperRef}>
      <Toolbar
        onZoomIn={() => applyZoom(1.25)}
        onZoomOut={() => applyZoom(0.8)}
        onReset={resetZoom}
        selectedBranches={selectedBranches}
        onClearBranches={() => selectedBranches.forEach((name) => onToggleBranch(name))}
      />
      <svg ref={svgRef} className="graph-svg" role="img" aria-label="Commit DAG visualization" />
    </section>
  );
}

function EmptyState() {
  return (
    <main className="empty-state">
      <div className="empty-copy">
        <GitBranch size={48} aria-hidden="true" />
        <h2>Paste a public GitHub repository URL to map its branch graph.</h2>
        <p>
          The app fetches public branches and commits, draws a draggable 2D DAG, and predicts risky merges
          from changed-file overlap.
        </p>
      </div>
    </main>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CommitPanel({ commit, details, loadingDetails }) {
  const files = details?.files || [];
  return (
    <div className="panel-content">
      <div className="panel-title-row">
        <GitCommitHorizontal size={20} />
        <div>
          <div className="panel-kicker">Commit</div>
          <h2>{commit.message}</h2>
        </div>
      </div>
      <div className="stat-grid">
        <Stat label="Hash" value={shortSha(commit.sha)} />
        <Stat label="Contributor" value={commit.author} />
        <Stat label="Date" value={formatDate(commit.date)} />
        <Stat label="Branches" value={commit.branches.join(', ')} />
      </div>
      {loadingDetails && <div className="loading-row"><Loader2 className="spin" size={18} /> Loading commit details</div>}
      {details && (
        <>
          <div className="stat-grid compact">
            <Stat label="Files changed" value={details.files?.length || 0} />
            <Stat label="Additions" value={details.stats?.additions || 0} />
            <Stat label="Deletions" value={details.stats?.deletions || 0} />
          </div>
          <div className="file-list">
            {files.slice(0, 8).map((file) => (
              <article className="file-card" key={file.filename}>
                <div className="file-card-header">
                  <strong>{file.filename}</strong>
                  <span>{file.status}</span>
                </div>
                <pre>{file.patch || 'No inline diff returned by the GitHub API.'}</pre>
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ContributorHeatmap({ contributors }) {
  const max = Math.max(...contributors.map((item) => item.count), 1);
  return (
    <div className="heatmap">
      {contributors.map((item) => (
        <div className="heatmap-row" key={item.name}>
          <span>{item.name}</span>
          <div className="heatbar">
            <i style={{ width: `${(item.count / max) * 100}%` }} />
          </div>
          <strong>{item.count}</strong>
        </div>
      ))}
    </div>
  );
}

function BranchPanel({ branches, branchName }) {
  const branch = branches.find((item) => item.name === branchName);
  if (!branch) return null;
  const contributors = summarizeBranch(branch);
  const additions = branch.changedFiles.reduce((sum, file) => sum + (file.additions || 0), 0);
  const deletions = branch.changedFiles.reduce((sum, file) => sum + (file.deletions || 0), 0);

  return (
    <div className="panel-content">
      <div className="panel-title-row">
        <span className="branch-dot" style={{ background: getBranchColor(branch) }} />
        <div>
          <div className="panel-kicker">Branch</div>
          <h2>{branch.name}</h2>
        </div>
      </div>
      <div className="stat-grid">
        <Stat label="Behind main" value={branch.behindBy} />
        <Stat label="Ahead" value={branch.aheadBy} />
        <Stat label="Commits sampled" value={branch.commits.length} />
        <Stat label="Changed files" value={branch.changedFiles.length} />
      </div>
      <div className="staleness-meter">
        <span>Branch staleness</span>
        <div>
          <i style={{ width: `${clamp(branch.behindBy * 3, 4, 100)}%` }} />
        </div>
      </div>
      <section className="panel-section">
        <h3>Contributor Heatmap</h3>
        <ContributorHeatmap contributors={contributors} />
      </section>
      <section className="panel-section">
        <h3>Change Summary</h3>
        <div className="stat-grid compact">
          <Stat label="Additions" value={additions} />
          <Stat label="Deletions" value={deletions} />
        </div>
        <div className="file-chips">
          {branch.changedFiles.slice(0, 16).map((file) => (
            <span key={file.filename}>{file.filename}</span>
          ))}
        </div>
      </section>
    </div>
  );
}

function MergePanel({ branches, selectedBranches }) {
  const [firstName, secondName] = selectedBranches;
  const first = branches.find((branch) => branch.name === firstName);
  const second = branches.find((branch) => branch.name === secondName);
  const prediction = predictConflicts(first, second);

  if (!prediction) return null;

  return (
    <div className="panel-content">
      <div className="panel-title-row">
        <GitMerge size={22} />
        <div>
          <div className="panel-kicker">Merge Prediction</div>
          <h2>{first.name} + {second.name}</h2>
        </div>
      </div>
      <div className={`risk-card ${prediction.risk.toLowerCase()}`}>
        <AlertTriangle size={22} />
        <div>
          <strong>{prediction.risk} conflict risk</strong>
          <span>{prediction.score}% predicted risk from changed-file and diff overlap</span>
        </div>
      </div>
      <div className="stat-grid">
        <Stat label="Overlapping files" value={prediction.overlapping.length} />
        <Stat label="Patch overlaps" value={prediction.patchOverlap.length} />
        <Stat label={`${first.name} behind`} value={first.behindBy} />
        <Stat label={`${second.name} behind`} value={second.behindBy} />
      </div>
      <section className="panel-section">
        <h3>Likely Conflict Hotspots</h3>
        {prediction.overlapping.length === 0 ? (
          <p className="muted">No changed-file overlap was returned by GitHub compare data.</p>
        ) : (
          <div className="file-list">
            {prediction.overlapping.slice(0, 10).map(({ fileName, first: firstFile, second: secondFile }) => (
              <article className="file-card" key={fileName}>
                <div className="file-card-header">
                  <strong>{fileName}</strong>
                  <span>{firstFile.status} / {secondFile.status}</span>
                </div>
                <p>
                  {first.name}: +{firstFile.additions || 0} -{firstFile.deletions || 0} · {second.name}: +
                  {secondFile.additions || 0} -{secondFile.deletions || 0}
                </p>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function SidePanel({
  open,
  mode,
  onClose,
  selectedCommit,
  commitDetails,
  loadingDetails,
  selectedBranches,
  branches,
}) {
  return (
    <aside className={`side-panel ${open ? 'open' : ''}`} aria-hidden={!open}>
      <button className="panel-close" type="button" onClick={onClose} aria-label="Close panel">
        <PanelRightClose size={19} />
      </button>
      {mode === 'commit' && selectedCommit && (
        <CommitPanel commit={selectedCommit} details={commitDetails} loadingDetails={loadingDetails} />
      )}
      {mode === 'branch' && selectedBranches.length === 1 && (
        <BranchPanel branches={branches} branchName={selectedBranches[0]} />
      )}
      {mode === 'merge' && selectedBranches.length === 2 && (
        <MergePanel branches={branches} selectedBranches={selectedBranches} />
      )}
    </aside>
  );
}

function App() {
  const [repoUrl, setRepoUrl] = useState('https://github.com/facebook/react');
  const [repoData, setRepoData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedCommits, setSelectedCommits] = useState([]);
  const [selectedCommit, setSelectedCommit] = useState(null);
  const [commitDetails, setCommitDetails] = useState(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [selectedBranches, setSelectedBranches] = useState([]);
  const [panelMode, setPanelMode] = useState(null);
  const [branchPanelWidth, setBranchPanelWidth] = useState(280);
  const [isResizingBranches, setIsResizingBranches] = useState(false);

  useEffect(() => {
    if (!isResizingBranches) return undefined;

    const handlePointerMove = (event) => {
      setBranchPanelWidth(clamp(event.clientX, 220, 520));
    };
    const handlePointerUp = () => {
      setIsResizingBranches(false);
    };

    document.body.classList.add('is-resizing-sidebar');
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      document.body.classList.remove('is-resizing-sidebar');
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [isResizingBranches]);

  const handleLoad = useCallback(async (event) => {
    event?.preventDefault();
    setLoading(true);
    setError('');
    setRepoData(null);
    setSelectedCommits([]);
    setSelectedBranches([]);
    setSelectedCommit(null);
    setCommitDetails(null);
    setPanelMode(null);

    try {
      const data = await loadRepository(repoUrl);
      setRepoData(data);
    } catch (loadError) {
      setError(loadError.message || 'Could not load that repository.');
    } finally {
      setLoading(false);
    }
  }, [repoUrl]);

  const handleToggleCommit = useCallback((sha) => {
    setSelectedCommits((current) => (
      current.includes(sha) ? current.filter((item) => item !== sha) : [...current, sha]
    ));
  }, []);

  const handleToggleBranch = useCallback((branchName) => {
    setSelectedBranches((current) => {
      const next = current.includes(branchName)
        ? current.filter((item) => item !== branchName)
        : [...current, branchName].slice(-2);
      setPanelMode(next.length === 2 ? 'merge' : next.length === 1 ? 'branch' : null);
      return next;
    });
  }, []);

  const handleNodeDetails = useCallback((commit) => {
    setSelectedCommit(commit);
    setCommitDetails(null);
    setPanelMode('commit');
    if (!repoData) return;
    setLoadingDetails(true);
    loadCommitDetails(repoData, commit.sha)
      .then(setCommitDetails)
      .catch(() => setCommitDetails(null))
      .finally(() => setLoadingDetails(false));
  }, [repoData]);

  const closePanel = useCallback(() => {
    setPanelMode(null);
    setSelectedCommit(null);
    setCommitDetails(null);
  }, []);

  return (
    <div className="app-shell">
      <Header
        repoUrl={repoUrl}
        setRepoUrl={setRepoUrl}
        onLoad={handleLoad}
        loading={loading}
        error={error}
        repoData={repoData}
      />
      {repoData ? (
        <main
          className="workspace"
          style={{ '--branch-panel-width': `${branchPanelWidth}px` }}
        >
          <BranchLegend
            branches={repoData.branches}
            selectedBranches={selectedBranches}
            onToggleBranch={handleToggleBranch}
          />
          <button
            className="sidebar-resizer"
            type="button"
            role="separator"
            aria-label="Resize branches panel"
            aria-orientation="vertical"
            aria-valuemin={220}
            aria-valuemax={520}
            aria-valuenow={branchPanelWidth}
            onPointerDown={(event) => {
              event.preventDefault();
              setIsResizingBranches(true);
            }}
          />
          <GraphCanvas
            graph={repoData.graph}
            branches={repoData.branches}
            selectedCommits={selectedCommits}
            selectedBranches={selectedBranches}
            onToggleCommit={handleToggleCommit}
            onToggleBranch={handleToggleBranch}
            onNodeDetails={handleNodeDetails}
          />
          <SidePanel
            open={Boolean(panelMode)}
            mode={panelMode}
            onClose={closePanel}
            selectedCommit={selectedCommit}
            commitDetails={commitDetails}
            loadingDetails={loadingDetails}
            selectedBranches={selectedBranches}
            branches={repoData.branches}
          />
        </main>
      ) : (
        <EmptyState />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
