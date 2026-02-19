import type Database from 'better-sqlite3';
import type { Prediction, Domain, DomainCalibration } from './predictions.js';

export interface BiasAnalysis {
  direction: 'overconfident' | 'underconfident' | 'well-calibrated';
  magnitude: number;
  details: string;
}

export interface DomainReport extends DomainCalibration {
  domain: Domain;
}

export interface CalibrationReportData {
  total_predictions: number;
  resolved: number;
  pending: number;
  overall_accuracy: number;
  overall_brier: number;
  average_confidence: number;
  by_domain: DomainReport[];
  bias: BiasAnalysis;
  recommendations: string[];
}

/**
 * Calculate the Brier score from a set of resolved predictions.
 * Brier score = mean of (confidence - outcome_value)^2
 *   where outcome_value is 1 for correct, 0 for incorrect, 0.5 for partial.
 * Lower is better. Voided predictions are excluded.
 */
export function brierScore(predictions: Prediction[]): number {
  const scorable = predictions.filter(
    (p) => p.outcome !== null && p.outcome !== 'voided',
  );

  if (scorable.length === 0) return 0;

  let sum = 0;
  for (const p of scorable) {
    const outcomeValue = p.outcome === 'correct' ? 1 : p.outcome === 'partial' ? 0.5 : 0;
    sum += (p.confidence - outcomeValue) ** 2;
  }

  return sum / scorable.length;
}

/**
 * Group predictions by domain and calculate accuracy + Brier score per domain.
 */
export function calibrationByDomain(db: Database.Database): DomainReport[] {
  const predictions = db.prepare(`
    SELECT * FROM predictions
    WHERE outcome IS NOT NULL AND outcome != 'voided'
  `).all() as Prediction[];

  const allDomains: Domain[] = ['political', 'technical', 'behavioral', 'market', 'general'];
  const grouped: Record<Domain, Prediction[]> = {
    political: [],
    technical: [],
    behavioral: [],
    market: [],
    general: [],
  };

  for (const p of predictions) {
    grouped[p.domain].push(p);
  }

  const reports: DomainReport[] = [];
  for (const domain of allDomains) {
    const domainPreds = grouped[domain];
    if (domainPreds.length === 0) continue;

    const correct = domainPreds.filter((p) => p.outcome === 'correct').length;
    const avgConfidence =
      domainPreds.reduce((sum, p) => sum + p.confidence, 0) / domainPreds.length;

    reports.push({
      domain,
      total: domainPreds.length,
      correct,
      accuracy: correct / domainPreds.length,
      average_confidence: avgConfidence,
      brier_score: brierScore(domainPreds),
    });
  }

  return reports;
}

/**
 * Detect systematic bias from calibration data.
 * Compares average confidence to actual accuracy.
 */
export function getSystematicBias(calibrationData: {
  average_confidence: number;
  accuracy: number;
  total: number;
}): BiasAnalysis {
  const gap = calibrationData.average_confidence - calibrationData.accuracy;
  const magnitude = Math.abs(gap);

  if (calibrationData.total < 5) {
    return {
      direction: 'well-calibrated',
      magnitude: 0,
      details: `Insufficient data (${calibrationData.total} predictions). Need at least 5 resolved predictions to assess bias.`,
    };
  }

  // Threshold: gaps under 5% are considered well-calibrated
  if (magnitude < 0.05) {
    return {
      direction: 'well-calibrated',
      magnitude,
      details: `Confidence (${fmt(calibrationData.average_confidence)}) closely matches accuracy (${fmt(calibrationData.accuracy)}). Gap: ${fmt(magnitude)}.`,
    };
  }

  if (gap > 0) {
    return {
      direction: 'overconfident',
      magnitude,
      details: `Average confidence (${fmt(calibrationData.average_confidence)}) exceeds accuracy (${fmt(calibrationData.accuracy)}) by ${fmt(magnitude)}. Predictions are systematically overconfident.`,
    };
  }

  return {
    direction: 'underconfident',
    magnitude,
    details: `Accuracy (${fmt(calibrationData.accuracy)}) exceeds average confidence (${fmt(calibrationData.average_confidence)}) by ${fmt(magnitude)}. Predictions are systematically underconfident.`,
  };
}

/**
 * Generate a full markdown calibration report.
 */
export function calibrationReport(db: Database.Database): string {
  const totalRow = db.prepare('SELECT COUNT(*) as c FROM predictions').get() as { c: number };
  const resolvedRow = db.prepare(
    "SELECT COUNT(*) as c FROM predictions WHERE outcome IS NOT NULL",
  ).get() as { c: number };
  const pendingRow = db.prepare(
    "SELECT COUNT(*) as c FROM predictions WHERE outcome IS NULL",
  ).get() as { c: number };

  const resolved = db.prepare(`
    SELECT * FROM predictions
    WHERE outcome IS NOT NULL AND outcome != 'voided'
  `).all() as Prediction[];

  const correct = resolved.filter((p) => p.outcome === 'correct').length;
  const accuracy = resolved.length > 0 ? correct / resolved.length : 0;
  const avgConfidence = resolved.length > 0
    ? resolved.reduce((sum, p) => sum + p.confidence, 0) / resolved.length
    : 0;
  const brier = brierScore(resolved);

  const domainReports = calibrationByDomain(db);
  const bias = getSystematicBias({
    average_confidence: avgConfidence,
    accuracy,
    total: resolved.length,
  });

  const recommendations = generateRecommendations(bias, domainReports, resolved.length);

  // Build markdown
  let md = '# Calibration Report\n\n';

  md += '## Overview\n\n';
  md += `| Metric | Value |\n`;
  md += `|--------|-------|\n`;
  md += `| Total predictions | ${totalRow.c} |\n`;
  md += `| Resolved | ${resolvedRow.c} |\n`;
  md += `| Pending | ${pendingRow.c} |\n`;
  md += `| Overall accuracy | ${fmt(accuracy)} |\n`;
  md += `| Average confidence | ${fmt(avgConfidence)} |\n`;
  md += `| Brier score | ${brier.toFixed(4)} |\n`;
  md += '\n';

  if (domainReports.length > 0) {
    md += '## By Domain\n\n';
    md += `| Domain | Count | Accuracy | Avg Confidence | Brier Score |\n`;
    md += `|--------|-------|----------|----------------|-------------|\n`;
    for (const dr of domainReports) {
      md += `| ${dr.domain} | ${dr.total} | ${fmt(dr.accuracy)} | ${fmt(dr.average_confidence)} | ${dr.brier_score.toFixed(4)} |\n`;
    }
    md += '\n';
  }

  md += '## Systematic Bias\n\n';
  md += `**Direction:** ${bias.direction}\n\n`;
  md += `${bias.details}\n\n`;

  if (recommendations.length > 0) {
    md += '## Recommendations\n\n';
    for (const rec of recommendations) {
      md += `- ${rec}\n`;
    }
    md += '\n';
  }

  return md;
}

function fmt(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function generateRecommendations(
  bias: BiasAnalysis,
  domainReports: DomainReport[],
  totalResolved: number,
): string[] {
  const recommendations: string[] = [];

  if (totalResolved < 10) {
    recommendations.push(
      'Make more predictions to build a meaningful calibration dataset. Current sample size is too small for reliable analysis.',
    );
  }

  if (bias.direction === 'overconfident') {
    recommendations.push(
      `Reduce confidence levels by approximately ${fmt(bias.magnitude)} on average. Consider adding more uncertainty to predictions.`,
    );
  } else if (bias.direction === 'underconfident') {
    recommendations.push(
      `Increase confidence levels by approximately ${fmt(bias.magnitude)} on average. Your track record supports higher confidence.`,
    );
  }

  // Flag domains with notably poor calibration
  for (const dr of domainReports) {
    if (dr.total >= 3 && dr.brier_score > 0.25) {
      recommendations.push(
        `Domain "${dr.domain}" has a high Brier score (${dr.brier_score.toFixed(4)}). Consider recalibrating predictions in this area.`,
      );
    }
    if (dr.total >= 3) {
      const domainGap = Math.abs(dr.average_confidence - dr.accuracy);
      if (domainGap > 0.15) {
        const direction = dr.average_confidence > dr.accuracy ? 'overconfident' : 'underconfident';
        recommendations.push(
          `Systematically ${direction} in "${dr.domain}" domain (confidence: ${fmt(dr.average_confidence)}, accuracy: ${fmt(dr.accuracy)}).`,
        );
      }
    }
  }

  // Check for domain gaps
  const allDomains: Domain[] = ['political', 'technical', 'behavioral', 'market', 'general'];
  const coveredDomains = new Set(domainReports.map((dr) => dr.domain));
  const missingDomains = allDomains.filter((d) => !coveredDomains.has(d));
  if (missingDomains.length > 0 && totalResolved >= 10) {
    recommendations.push(
      `No resolved predictions in: ${missingDomains.join(', ')}. Consider diversifying prediction domains.`,
    );
  }

  return recommendations;
}
