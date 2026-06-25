# GitHub Tree Visualizer

A Vite + React web app for visualizing public GitHub repository branches as an interactive 2D commit DAG.

## Features

- Paste a public GitHub repository URL and fetch branch/commit data with Octokit.
- Pan, zoom, and drag commit nodes with D3.
- Color-coded branches with stale branches dulled based on how far they are behind the default branch.
- Click a commit node to toggle it and inspect commit summary, changed files, and inline diffs.
- Click an edge to select a whole branch and view contributor heatmaps plus branch stats.
- Select two branches to show merge-conflict risk prediction from compare API diffs.

## Development

```bash
npm install
npm run dev
```

Optionally set `VITE_GITHUB_TOKEN` in `.env.local` to raise GitHub API limits for local development and Vercel deployments.

## Deploy

Deploy directly to Vercel as a Vite app. The included `vercel.json` uses `npm run build` and serves `dist`.
