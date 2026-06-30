# GitHub Tree Visualizer

A Vite + React web app for visualizing public GitHub repository branches as an interactive 2D commit DAG.

## Features

- Paste a public GitHub repository URL and fetch branch/commit data through a server-side Vercel proxy.
- Pan, zoom, and drag commit nodes with D3.
- Color-coded branches with stale branches dulled based on how far they are behind the default branch.
- Click a commit node to toggle it and inspect commit summary, changed files, and inline diffs.
- Click an edge to select a whole branch and view contributor heatmaps plus branch stats.
- Select two branches to show merge-conflict risk prediction from compare API diffs.

## Development

```bash
npm install
npx vercel dev
```

Create `.env.local` for local development:

```bash
GITHUB_TOKEN=github_pat_your_token_here
```

The frontend calls `/api/github`; the Vercel Function in `api/github.js` reads `process.env.GITHUB_TOKEN` and talks to GitHub with Octokit. Do not use a `VITE_` prefix for the token, because Vite exposes `VITE_*` variables in browser bundles.

## Deploy

Deploy directly to Vercel as a Vite app. The included `vercel.json` uses `npm run build` and serves `dist`.

1. Push this repo to GitHub.
2. Import it at <https://vercel.com/new>.
3. Keep the Vite defaults: build command `npm run build`, output directory `dist`.
4. In Vercel, open **Project Settings > Environment Variables**.
5. Add `GITHUB_TOKEN` for Production and Preview.
6. Redeploy after adding or rotating the token.

## Token Safety

- `api/github.js` is the server backend. Files in `api/` become Vercel Functions and run on the server.
- `src/` is browser code. It should never read `process.env.GITHUB_TOKEN` or `import.meta.env.VITE_GITHUB_TOKEN`.
- If the GitHub token expires, create a new PAT, update `GITHUB_TOKEN` in Vercel, and redeploy.
