import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
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

const DEFAULT_BRANCH_LIMIT = 12;
const CLIENT_MAX_BRANCH_LIMIT = 50;
const LANE_WIDTH = 112;
const ROW_HEIGHT = 72;
const GRAPH_LEFT_PADDING = 130;
const GRAPH_TOP_PADDING = 92;

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

function hashString(value) {
  return [...value].reduce((hash, character) => {
    return (hash * 31 + character.charCodeAt(0)) % 997;
  }, 7);
}

function organicBranchPath(edge) {
  const { source, target } = edge;
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const wobble = (hashString(edge.branch) % 15) - 7;

  if (Math.abs(dx) < 2) {
    const midY = source.y + dy / 2;
    return `M${source.x},${source.y}C${source.x + wobble},${midY} ${target.x - wobble},${midY} ${target.x},${target.y}`;
  }

  const sign = Math.sign(dx);
  const verticalSign = Math.sign(dy) || -1;
  const radius = Math.min(36, Math.abs(dx) * 0.4, Math.max(18, Math.abs(dy) * 0.34));
  const leadY = target.y - verticalSign * radius;
  const exitX = source.x + sign * radius;
  const enterX = target.x - sign * radius;

  return [
    `M${source.x},${source.y}`,
    `C${source.x + wobble},${source.y + dy * 0.36} ${source.x + wobble},${leadY} ${source.x},${leadY}`,
    `Q${source.x},${target.y} ${exitX},${target.y}`,
    `C${source.x + dx * 0.38},${target.y + wobble * 0.18} ${source.x + dx * 0.62},${target.y - wobble * 0.18} ${enterX},${target.y}`,
    `Q${target.x},${target.y} ${target.x},${target.y}`,
  ].join('');
}

async function loadRepository(repoUrl, branchLimit = DEFAULT_BRANCH_LIMIT) {
  const params = new URLSearchParams({
    action: 'repository',
    repoUrl,
    branchLimit: String(branchLimit),
  });
  const response = await fetch(`/api/github?${params.toString()}`);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Could not load that repository.');
  }

  return data;
}

async function loadCommitDetails(repoData, sha) {
  const params = new URLSearchParams({
    action: 'commit',
    owner: repoData.owner,
    repo: repoData.repo,
    sha,
  });
  const response = await fetch(`/api/github?${params.toString()}`);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Could not load commit details.');
  }

  return data;
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

function Toolbar({
  onZoomIn,
  onZoomOut,
  onReset,
  selectedBranches,
  onClearBranches,
  branchLimit,
  maxBranchLimit,
  onBranchLimitChange,
  loading,
}) {
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
      <label className="branch-limit-control">
        <span>Top {branchLimit} branches</span>
        <input
          type="range"
          min="2"
          max={maxBranchLimit}
          value={branchLimit}
          disabled={loading}
          onChange={(event) => onBranchLimitChange(Number(event.target.value))}
          aria-label="Top branches by recent activity"
        />
      </label>
    </div>
  );
}

function BranchLegend({ branches, selectedBranches, onToggleBranch, onFocusBranch }) {
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
              onClick={() => {
                onToggleBranch(branch.name);
                onFocusBranch(branch.name);
              }}
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
  focusRequest,
  branchLimit,
  maxBranchLimit,
  onBranchLimitChange,
  loading,
  onToggleCommit,
  onToggleBranch,
  onNodeDetails,
}) {
  const svgRef = useRef(null);
  const wrapperRef = useRef(null);
  const zoomRef = useRef(null);
  const nodePositionsRef = useRef(new Map());
  const layoutNodesRef = useRef([]);
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
      .attr('d', organicBranchPath)
      .attr('fill', 'none')
      .attr('stroke-linecap', 'round')
      .attr('stroke-linejoin', 'round')
      .on('click', (event, edge) => {
        event.stopPropagation();
        onToggleBranch(edge.branch);
      });

    link.append('title').text((edge) => `Select branch ${edge.branch}`);

    const updateGraph = () => {
      link.attr('d', organicBranchPath);
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
    layoutNodesRef.current = nodes;
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

  useEffect(() => {
    if (!focusRequest || !svgRef.current || !wrapperRef.current || !zoomRef.current) return;

    const branchNodes = layoutNodesRef.current.filter((node) => node.branches.includes(focusRequest.name));
    if (!branchNodes.length) return;

    const bounds = branchNodes.reduce((box, node) => ({
      minX: Math.min(box.minX, node.x),
      maxX: Math.max(box.maxX, node.x),
      minY: Math.min(box.minY, node.y),
      maxY: Math.max(box.maxY, node.y),
    }), {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    });
    const { width, height } = wrapperRef.current.getBoundingClientRect();
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    const spanX = Math.max(bounds.maxX - bounds.minX, LANE_WIDTH);
    const spanY = Math.max(bounds.maxY - bounds.minY, ROW_HEIGHT * 4);
    const scale = clamp(Math.min(width / (spanX + 260), height / (spanY + 180), 1.35), 0.55, 1.35);
    const transform = d3.zoomIdentity
      .translate(width / 2 - centerX * scale, height / 2 - centerY * scale)
      .scale(scale);

    d3.select(svgRef.current)
      .transition()
      .duration(420)
      .call(zoomRef.current.transform, transform);
  }, [focusRequest]);

  return (
    <section className="graph-section" ref={wrapperRef}>
      <Toolbar
        onZoomIn={() => applyZoom(1.25)}
        onZoomOut={() => applyZoom(0.8)}
        onReset={resetZoom}
        selectedBranches={selectedBranches}
        onClearBranches={() => selectedBranches.forEach((name) => onToggleBranch(name))}
        branchLimit={branchLimit}
        maxBranchLimit={maxBranchLimit}
        onBranchLimitChange={onBranchLimitChange}
        loading={loading}
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
        <h3>Top Contributors</h3>
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
  const [branchLimit, setBranchLimit] = useState(DEFAULT_BRANCH_LIMIT);
  const [focusRequest, setFocusRequest] = useState(null);
  const branchLimitTimerRef = useRef(null);

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

  useEffect(() => {
    return () => {
      window.clearTimeout(branchLimitTimerRef.current);
    };
  }, []);

  const refreshRepository = useCallback(async (nextBranchLimit, resetBeforeLoad = false) => {
    setLoading(true);
    setError('');
    if (resetBeforeLoad) {
      setRepoData(null);
    }
    setSelectedCommits([]);
    setSelectedBranches([]);
    setSelectedCommit(null);
    setCommitDetails(null);
    setPanelMode(null);
    setFocusRequest(null);

    try {
      const data = await loadRepository(repoUrl, nextBranchLimit);
      setRepoData(data);
      setBranchLimit(data.branchLimit || nextBranchLimit);
    } catch (loadError) {
      setError(loadError.message || 'Could not load that repository.');
    } finally {
      setLoading(false);
    }
  }, [repoUrl]);

  const handleLoad = useCallback(async (event) => {
    event?.preventDefault();
    window.clearTimeout(branchLimitTimerRef.current);
    await refreshRepository(branchLimit, true);
  }, [branchLimit, refreshRepository]);

  const handleBranchLimitChange = useCallback((nextLimit) => {
    const next = clamp(nextLimit, 2, repoData?.maxBranchLimit || CLIENT_MAX_BRANCH_LIMIT);
    setBranchLimit(next);
    window.clearTimeout(branchLimitTimerRef.current);

    if (!repoData) return;

    branchLimitTimerRef.current = window.setTimeout(() => {
      refreshRepository(next, false);
    }, 450);
  }, [refreshRepository, repoData]);

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

  const handleFocusBranch = useCallback((branchName) => {
    setFocusRequest({ name: branchName, requestedAt: Date.now() });
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

  const maxBranchLimit = repoData?.availableBranchCount
    ? clamp(repoData.availableBranchCount, 2, repoData.maxBranchLimit || CLIENT_MAX_BRANCH_LIMIT)
    : CLIENT_MAX_BRANCH_LIMIT;

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
            onFocusBranch={handleFocusBranch}
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
            focusRequest={focusRequest}
            branchLimit={branchLimit}
            maxBranchLimit={maxBranchLimit}
            onBranchLimitChange={handleBranchLimitChange}
            loading={loading}
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
