/**
 * Calibration Dashboard for Vokari.
 *
 * Lightweight HTTP server that serves a Chart.js visualization
 * of prediction calibration, belief stats, and verification status.
 *
 * Usage:
 *   npx tsx src/dashboard.ts [--port 3939] [--db ./epistemic.db]
 *   vokari dashboard [--port 3939]
 */

import { createServer } from 'http';
import type Database from 'better-sqlite3';
import { calibrationByDomain, getSystematicBias, brierScore } from './calibration.js';
import { getBeliefStats } from './beliefs.js';
import { verificationStatus } from './verification.js';
import { getKnowledgeStats } from './knowledge.js';
import { getPendingReview } from './predictions.js';
import { compileDigest } from './digest.js';
import type { Prediction } from './predictions.js';

export interface DashboardData {
  calibration: {
    total: number;
    resolved: number;
    pending: number;
    accuracy: number;
    brier_score: number;
    average_confidence: number;
    bias: { direction: string; magnitude: number; details: string };
    by_domain: { domain: string; total: number; correct: number; accuracy: number; avg_confidence: number; brier: number }[];
    buckets: { bucket: string; expected: number; actual: number; count: number }[];
  };
  beliefs: {
    total: number;
    active: number;
    challenged: number;
    revised: number;
    retired: number;
    by_category: Record<string, number>;
    contradictions: number;
  };
  verification: {
    total: number;
    completed: number;
    pending: number;
    confirmed: number;
    contradicted: number;
    coverage_pct: number;
  };
  knowledge: {
    total: number;
    by_type: { type: string; count: number }[];
  };
}

/**
 * Build confidence calibration buckets.
 * Groups predictions into 10% confidence bands (0-10%, 10-20%, ..., 90-100%)
 * and compares expected vs actual accuracy for each band.
 */
function calibrationBuckets(db: Database.Database): DashboardData['calibration']['buckets'] {
  const predictions = db.prepare(`
    SELECT confidence, outcome FROM predictions
    WHERE outcome IS NOT NULL AND outcome != 'voided'
  `).all() as Pick<Prediction, 'confidence' | 'outcome'>[];

  const buckets: { lo: number; hi: number; sum_conf: number; correct: number; total: number }[] = [];
  for (let i = 0; i < 10; i++) {
    buckets.push({ lo: i / 10, hi: (i + 1) / 10, sum_conf: 0, correct: 0, total: 0 });
  }

  for (const p of predictions) {
    const idx = Math.min(Math.floor(p.confidence * 10), 9);
    buckets[idx].total++;
    buckets[idx].sum_conf += p.confidence;
    if (p.outcome === 'correct') buckets[idx].correct++;
    if (p.outcome === 'partial') buckets[idx].correct += 0.5;
  }

  return buckets
    .filter(b => b.total > 0)
    .map(b => ({
      bucket: `${Math.round(b.lo * 100)}-${Math.round(b.hi * 100)}%`,
      expected: b.sum_conf / b.total,
      actual: b.correct / b.total,
      count: b.total,
    }));
}

/**
 * Assemble all dashboard data from the database.
 */
export function getDashboardData(db: Database.Database): DashboardData {
  // Calibration
  const totalPredictions = (db.prepare('SELECT COUNT(*) as c FROM predictions').get() as { c: number }).c;
  const resolvedPredictions = db.prepare(
    "SELECT * FROM predictions WHERE outcome IS NOT NULL AND outcome != 'voided'"
  ).all() as Prediction[];
  const pendingPredictions = (db.prepare(
    "SELECT COUNT(*) as c FROM predictions WHERE outcome IS NULL"
  ).get() as { c: number }).c;

  const correct = resolvedPredictions.filter(p => p.outcome === 'correct').length;
  const accuracy = resolvedPredictions.length > 0 ? correct / resolvedPredictions.length : 0;
  const avgConf = resolvedPredictions.length > 0
    ? resolvedPredictions.reduce((s, p) => s + p.confidence, 0) / resolvedPredictions.length
    : 0;
  const brier = brierScore(resolvedPredictions);
  const bias = getSystematicBias({ average_confidence: avgConf, accuracy, total: resolvedPredictions.length });
  const domainReports = calibrationByDomain(db);
  const buckets = calibrationBuckets(db);

  // Beliefs
  const beliefStats = getBeliefStats(db);

  // Verification
  const verStats = verificationStatus(db);
  const totalBeliefs = beliefStats.total;
  const coveragePct = totalBeliefs > 0
    ? Math.round((verStats.beliefs_verified / totalBeliefs) * 100)
    : 0;

  // Knowledge
  const knowledgeStats = getKnowledgeStats(db);

  return {
    calibration: {
      total: totalPredictions,
      resolved: resolvedPredictions.length,
      pending: pendingPredictions,
      accuracy,
      brier_score: brier,
      average_confidence: avgConf,
      bias: { direction: bias.direction, magnitude: bias.magnitude, details: bias.details },
      by_domain: domainReports.map(d => ({
        domain: d.domain,
        total: d.total,
        correct: d.correct,
        accuracy: d.accuracy,
        avg_confidence: d.average_confidence,
        brier: d.brier_score,
      })),
      buckets,
    },
    beliefs: {
      total: beliefStats.total,
      active: beliefStats.byStatus.active,
      challenged: beliefStats.byStatus.challenged,
      revised: beliefStats.byStatus.revised,
      retired: beliefStats.byStatus.retired,
      by_category: beliefStats.byCategory,
      contradictions: beliefStats.totalContradictions,
    },
    verification: {
      total: verStats.total,
      completed: verStats.by_status.completed,
      pending: verStats.by_status.pending + verStats.by_status.in_progress,
      confirmed: verStats.by_outcome.confirmed,
      contradicted: verStats.by_outcome.contradicted,
      coverage_pct: coveragePct,
    },
    knowledge: {
      total: knowledgeStats.total,
      by_type: knowledgeStats.byType,
    },
  };
}

/** Inline HTML dashboard with Chart.js CDN. */
function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vokari Calibration Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #0d1117; color: #c9d1d9; padding: 24px; }
  h1 { font-size: 1.5rem; margin-bottom: 8px; color: #58a6ff; }
  h2 { font-size: 1.1rem; margin: 16px 0 8px; color: #8b949e; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin-top: 16px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
  .stat { display: inline-block; margin-right: 20px; margin-bottom: 8px; }
  .stat-value { font-size: 1.4rem; font-weight: 600; color: #f0f6fc; }
  .stat-label { font-size: 0.75rem; color: #8b949e; }
  .bias-well { color: #3fb950; }
  .bias-over { color: #f85149; }
  .bias-under { color: #d29922; }
  canvas { max-height: 280px; }
  .loading { text-align: center; padding: 40px; color: #8b949e; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #21262d; font-size: 0.85rem; }
  th { color: #8b949e; }
</style>
</head>
<body>
<h1>Vokari Calibration Dashboard</h1>
<div id="app" class="loading">Loading...</div>
<script>
(async () => {
  const resp = await fetch('/api/dashboard');
  const data = await resp.json();
  const app = document.getElementById('app');
  app.className = '';

  const pct = v => (v * 100).toFixed(1) + '%';
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const biasClass = d => d === 'well-calibrated' ? 'bias-well' : d === 'overconfident' ? 'bias-over' : 'bias-under';

  let html = '<div class="grid">';

  // Calibration overview
  html += '<div class="card"><h2>Calibration</h2>';
  html += '<div class="stat"><div class="stat-value">' + pct(data.calibration.accuracy) + '</div><div class="stat-label">Accuracy</div></div>';
  html += '<div class="stat"><div class="stat-value">' + data.calibration.brier_score.toFixed(4) + '</div><div class="stat-label">Brier Score</div></div>';
  html += '<div class="stat"><div class="stat-value">' + pct(data.calibration.average_confidence) + '</div><div class="stat-label">Avg Confidence</div></div>';
  html += '<div class="stat"><div class="stat-value ' + biasClass(data.calibration.bias.direction) + '">' + esc(data.calibration.bias.direction) + '</div><div class="stat-label">Bias</div></div>';
  html += '<div class="stat"><div class="stat-value">' + data.calibration.total + '</div><div class="stat-label">Total</div></div>';
  html += '<div class="stat"><div class="stat-value">' + data.calibration.resolved + '</div><div class="stat-label">Resolved</div></div>';
  html += '<div class="stat"><div class="stat-value">' + data.calibration.pending + '</div><div class="stat-label">Pending</div></div>';
  html += '</div>';

  // Calibration chart
  html += '<div class="card"><h2>Calibration Curve</h2><canvas id="calChart"></canvas></div>';

  // Domain breakdown
  if (data.calibration.by_domain.length > 0) {
    html += '<div class="card"><h2>By Domain</h2><canvas id="domainChart"></canvas></div>';
  }

  // Beliefs
  html += '<div class="card"><h2>Beliefs</h2>';
  html += '<div class="stat"><div class="stat-value">' + data.beliefs.total + '</div><div class="stat-label">Total</div></div>';
  html += '<div class="stat"><div class="stat-value">' + data.beliefs.active + '</div><div class="stat-label">Active</div></div>';
  html += '<div class="stat"><div class="stat-value">' + data.beliefs.challenged + '</div><div class="stat-label">Challenged</div></div>';
  html += '<div class="stat"><div class="stat-value">' + data.beliefs.contradictions + '</div><div class="stat-label">Contradictions</div></div>';
  html += '<canvas id="beliefChart"></canvas></div>';

  // Verification
  html += '<div class="card"><h2>Verification</h2>';
  html += '<div class="stat"><div class="stat-value">' + data.verification.coverage_pct + '%</div><div class="stat-label">Coverage</div></div>';
  html += '<div class="stat"><div class="stat-value">' + data.verification.completed + '</div><div class="stat-label">Completed</div></div>';
  html += '<div class="stat"><div class="stat-value">' + data.verification.confirmed + '</div><div class="stat-label">Confirmed</div></div>';
  html += '<div class="stat"><div class="stat-value">' + data.verification.contradicted + '</div><div class="stat-label">Contradicted</div></div>';
  html += '</div>';

  // Knowledge
  if (data.knowledge.total > 0) {
    html += '<div class="card"><h2>Knowledge Store</h2>';
    html += '<div class="stat"><div class="stat-value">' + data.knowledge.total + '</div><div class="stat-label">Total Entries</div></div>';
    html += '<table><tr><th>Type</th><th>Count</th></tr>';
    for (const t of data.knowledge.by_type) {
      html += '<tr><td>' + esc(t.type) + '</td><td>' + Number(t.count) + '</td></tr>';
    }
    html += '</table></div>';
  }

  html += '</div>';
  app.innerHTML = html;

  // Calibration curve chart
  const buckets = data.calibration.buckets;
  if (buckets.length > 0) {
    new Chart(document.getElementById('calChart'), {
      type: 'bar',
      data: {
        labels: buckets.map(b => b.bucket),
        datasets: [
          { label: 'Expected', data: buckets.map(b => b.expected), backgroundColor: '#30363d', borderColor: '#484f58', borderWidth: 1 },
          { label: 'Actual', data: buckets.map(b => b.actual), backgroundColor: '#1f6feb', borderColor: '#58a6ff', borderWidth: 1 },
        ],
      },
      options: {
        responsive: true,
        scales: { y: { min: 0, max: 1, ticks: { callback: v => (v * 100) + '%', color: '#8b949e' }, grid: { color: '#21262d' } }, x: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } } },
        plugins: { legend: { labels: { color: '#c9d1d9' } }, tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + (ctx.raw * 100).toFixed(1) + '%' } } },
      },
    });
  }

  // Domain chart
  if (data.calibration.by_domain.length > 0) {
    const domains = data.calibration.by_domain;
    new Chart(document.getElementById('domainChart'), {
      type: 'bar',
      data: {
        labels: domains.map(d => d.domain),
        datasets: [
          { label: 'Accuracy', data: domains.map(d => d.accuracy), backgroundColor: '#3fb950' },
          { label: 'Avg Confidence', data: domains.map(d => d.avg_confidence), backgroundColor: '#d29922' },
        ],
      },
      options: {
        responsive: true,
        scales: { y: { min: 0, max: 1, ticks: { callback: v => (v * 100) + '%', color: '#8b949e' }, grid: { color: '#21262d' } }, x: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } } },
        plugins: { legend: { labels: { color: '#c9d1d9' } } },
      },
    });
  }

  // Belief category chart
  const cats = data.beliefs.by_category;
  const catLabels = Object.keys(cats).filter(k => cats[k] > 0);
  if (catLabels.length > 0) {
    new Chart(document.getElementById('beliefChart'), {
      type: 'doughnut',
      data: {
        labels: catLabels,
        datasets: [{ data: catLabels.map(k => cats[k]), backgroundColor: ['#58a6ff', '#3fb950', '#d29922', '#f85149'] }],
      },
      options: { responsive: true, plugins: { legend: { labels: { color: '#c9d1d9' } } } },
    });
  }
})();
</script>
</body>
</html>`;
}

/**
 * Start the dashboard HTTP server.
 */
export function startDashboard(db: Database.Database, port: number = 3838, host: string = '127.0.0.1'): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    const url = req.url ?? '/';

    // JSON API endpoints
    if (url === '/api/dashboard') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getDashboardData(db)));
    } else if (url === '/api/calibration') {
      const data = getDashboardData(db);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data.calibration));
    } else if (url === '/api/beliefs/stats') {
      const data = getDashboardData(db);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data.beliefs));
    } else if (url === '/api/predictions/pending') {
      try {
        const pending = getPendingReview(db);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(pending));
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
      }
    } else if (url === '/api/verification/status') {
      const data = getDashboardData(db);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data.verification));
    } else if (url.startsWith('/api/digest')) {
      try {
        const urlObj = new URL(url, 'http://localhost');
        const since = urlObj.searchParams.get('since') ?? undefined;
        const result = compileDigest(db, { since });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ digest: '', stats: { totalChanges: 0 }, sources: [] }));
      }

    // HTML dashboard
    } else if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(dashboardHtml());
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(port, host, () => {
    console.log(`Vokari dashboard: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  });

  return server;
}

// CLI entry point
if (process.argv[1]?.endsWith('dashboard.ts') || process.argv[1]?.endsWith('dashboard.js')) {
  const args = process.argv.slice(2);
  const portIdx = args.indexOf('--port');
  const port = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 3838;
  const dbIdx = args.indexOf('--db');
  const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : process.env.EPISTEMIC_DB ?? './epistemic.db';

  const { initDb } = await import('./db.js');

  // initDb already calls initKnowledge; calling it again now costs a second FTS rebuild.
  const db = initDb(dbPath);

  startDashboard(db, port);
}
