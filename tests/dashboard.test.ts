import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import http from 'http';
import { initDb } from '../src/db.js';
import { addCorrection } from '../src/corrections.js';
import { initBeliefs, addBelief } from '../src/beliefs.js';
import { initPredictions, addPrediction, resolvePrediction } from '../src/predictions.js';
import { initPositions } from '../src/positions.js';
import { initVerifications } from '../src/verification.js';
import { initKnowledge } from '../src/knowledge.js';
import { getDashboardData, startDashboard } from '../src/dashboard.js';

let db: Database.Database;

function initAllTables(database: Database.Database): void {
  initBeliefs(database);
  initPredictions(database);
  initPositions(database);
  initVerifications(database);
  initKnowledge(database);
}

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    }).on('error', reject);
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ── getDashboardData unit tests ──

describe('getDashboardData', () => {
  beforeEach(() => {
    db = initDb(':memory:');
    initAllTables(db);
  });

  it('returns valid structure on empty db', () => {
    const data = getDashboardData(db);
    expect(data.calibration).toBeDefined();
    expect(data.beliefs).toBeDefined();
    expect(data.verification).toBeDefined();
    expect(data.knowledge).toBeDefined();
    expect(data.calibration.total).toBe(0);
    expect(data.beliefs.total).toBe(0);
    expect(data.verification.total).toBe(0);
  });

  it('calibration data matches direct DB queries', () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    const id1 = addPrediction(db, {
      topic: 'weather',
      prediction: 'It will rain',
      confidence: 0.8,
      check_date: pastDate,
      domain: 'general',
    });
    resolvePrediction(db, id1, 'correct');

    const id2 = addPrediction(db, {
      topic: 'sports',
      prediction: 'Team A wins',
      confidence: 0.6,
      check_date: pastDate,
      domain: 'general',
    });
    resolvePrediction(db, id2, 'incorrect');

    const data = getDashboardData(db);
    expect(data.calibration.total).toBe(2);
    expect(data.calibration.resolved).toBe(2);
    expect(data.calibration.pending).toBe(0);
    expect(data.calibration.accuracy).toBe(0.5);
    expect(data.calibration.brier_score).toBeGreaterThan(0);
    expect(data.calibration.buckets.length).toBeGreaterThan(0);
  });

  it('belief stats match direct DB state', () => {
    addBelief(db, { statement: 'Sky is blue', category: 'world', confidence: 0.9 });
    addBelief(db, { statement: 'User likes dark mode', category: 'user', confidence: 0.8 });

    const data = getDashboardData(db);
    expect(data.beliefs.total).toBe(2);
    expect(data.beliefs.active).toBe(2);
    expect(data.beliefs.by_category.world).toBe(1);
    expect(data.beliefs.by_category.user).toBe(1);
  });

  it('verification coverage reflects unverified beliefs', () => {
    addBelief(db, { statement: 'Test belief', category: 'world' });
    const data = getDashboardData(db);
    expect(data.verification.coverage_pct).toBe(0);
  });

  it('calibration buckets group by confidence band', () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    // Add several predictions at different confidence levels
    for (let i = 0; i < 3; i++) {
      const id = addPrediction(db, {
        topic: 'test',
        prediction: `Prediction ${i}`,
        confidence: 0.9,
        check_date: pastDate,
      });
      resolvePrediction(db, id, 'correct');
    }
    const id = addPrediction(db, {
      topic: 'test',
      prediction: 'Low confidence',
      confidence: 0.3,
      check_date: pastDate,
    });
    resolvePrediction(db, id, 'incorrect');

    const data = getDashboardData(db);
    expect(data.calibration.buckets.length).toBe(2); // 30-40% and 90-100%
    const highBucket = data.calibration.buckets.find(b => b.bucket === '90-100%');
    expect(highBucket).toBeDefined();
    expect(highBucket!.count).toBe(3);
    expect(highBucket!.actual).toBe(1); // 3/3 = 100%
  });
});

// ── HTTP API tests ──

describe('dashboard HTTP API', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    db = initDb(':memory:');
    initAllTables(db);
    // Use a random high port to avoid conflicts between parallel test runs
    port = 39400 + Math.floor(Math.random() * 500);
    server = startDashboard(db, port);
    // Wait for server to start listening
    await new Promise<void>((resolve) => {
      if (server.listening) return resolve();
      server.on('listening', resolve);
    });
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it('/api/dashboard returns valid JSON with all sections', async () => {
    addBelief(db, { statement: 'Test belief', category: 'world' });
    const res = await httpGet(`http://localhost:${port}/api/dashboard`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.calibration).toBeDefined();
    expect(data.beliefs).toBeDefined();
    expect(data.verification).toBeDefined();
    expect(data.knowledge).toBeDefined();
    expect(data.beliefs.total).toBe(1);
  });

  it('/api/calibration returns calibration subset', async () => {
    const res = await httpGet(`http://localhost:${port}/api/calibration`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveProperty('total');
    expect(data).toHaveProperty('resolved');
    expect(data).toHaveProperty('brier_score');
    expect(data).toHaveProperty('buckets');
    expect(data).toHaveProperty('by_domain');
  });

  it('/api/beliefs/stats returns belief statistics', async () => {
    addBelief(db, { statement: 'Test', category: 'world' });
    const res = await httpGet(`http://localhost:${port}/api/beliefs/stats`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.total).toBe(1);
    expect(data).toHaveProperty('active');
    expect(data).toHaveProperty('by_category');
  });

  it('/api/predictions/pending returns array', async () => {
    const res = await httpGet(`http://localhost:${port}/api/predictions/pending`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(Array.isArray(data)).toBe(true);
  });

  it('/api/verification/status returns verification data', async () => {
    const res = await httpGet(`http://localhost:${port}/api/verification/status`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveProperty('total');
    expect(data).toHaveProperty('completed');
    expect(data).toHaveProperty('coverage_pct');
  });

  it('/api/digest returns digest data', async () => {
    const res = await httpGet(`http://localhost:${port}/api/digest`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveProperty('digest');
  });

  it('/ returns HTML dashboard', async () => {
    const res = await httpGet(`http://localhost:${port}/`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('Vokari Calibration Dashboard');
    expect(res.body).toContain('<!DOCTYPE html>');
  });

  it('unknown path returns 404', async () => {
    const res = await httpGet(`http://localhost:${port}/nonexistent`);
    expect(res.status).toBe(404);
  });
});
