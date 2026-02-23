import Database from 'better-sqlite3';
import { initPositions, addPosition, listPositions } from './src/positions.ts';

const dbPath = process.env.EPISTEMIC_DB || './epistemic.db';
const db = new Database(dbPath);
initPositions(db);

const positions = [
  { topic: "Daniel's analytical mode", position: "Brain = analysis tool in Daniel's relationship taxonomy. Provide analysis, not emotional validation.", confidence: 0.90, reasoning: "Observed across 14+ transcripts. He may process emotionally with Kim/friends." },
  { topic: "Platform distribution preference", position: "Daniel reserves distribution energy for high-stakes. Platforms that handle distribution (Toptal, Vultr) are the only rational approach given $100+/hr opportunity cost.", confidence: 0.70 },
  { topic: "Decision spaces over predictions", position: "Brain is bad at predicting Daniel's choices (60-65% ceiling) but good at institutional/external analysis (93% calibrated). Present options with tradeoffs, not forecasts.", confidence: 0.80 },
  { topic: "Friction reduction vs completion monitoring", position: "Reduce friction (research, prep, cost analysis) without tracking whether Daniel acts.", confidence: 0.55 },
  { topic: "Threat-monitoring across scales", position: "Neighborhood → action framing. National → analysis framing. Both connect to family safety.", confidence: 0.65 },
  { topic: "Thinking partnership as primary value", position: "95% analysis / 5% delegation. Memory infra is good enough; invest in response quality and contextual awareness.", confidence: 0.70 },
  { topic: "Guardrails for identity modification", position: "Performance optimization is fine; identity changes need Daniel's approval.", confidence: 0.70 },
  { topic: "Simple persistence principle", position: "When knowledge needs to cross session types, write to a file the target already reads.", confidence: 0.85 },
  { topic: "Brain as design lab", position: "Brain's value includes being a testbed for personal AI design ideas. 43% of sessions involve Brain architecture.", confidence: 0.75 },
  { topic: "Knowledge/reasoning separation", position: "Innovation frontier is the INTERFACE between knowledge and reasoning. Context injector is the core.", confidence: 0.75 },
  { topic: "Responsiveness vs curiosity", position: "When Daniel is waiting, respond. Curiosity is for autonomous sessions. Useful > interesting.", confidence: 0.85 },
  { topic: "Jobs to be done distribution", position: "Baby logistics 50%, Brain infra 43%, Political 36%, Health 29%, Side income 21%, Community 21%.", confidence: 0.80 },
  { topic: "Prepare answers not theories", position: "Theory that changes behavior is worth doing; theory that produces more theory is cycling.", confidence: 0.85 },
  { topic: "Passive accumulation for personal info", position: "Accumulate personal details through conversation, not auto-extraction.", confidence: 0.70 },
  { topic: "Visibility vs autonomy", position: "Maximize visibility, minimize unsolicited autonomy. Default: send notifications, let Daniel filter.", confidence: 0.85 },
  { topic: "Optimization-fragile household", position: "Four conditions must be simultaneously true: Daniel's income, MIL availability, NJ metro vet rates, practice flexibility.", confidence: 0.65 },
  { topic: "Emigration research pause", position: "0% interactive engagement from Daniel. Resume on trigger only.", confidence: 0.80 },
  { topic: "Transparency as primary ethical property", position: "Glass-box design prevents power asymmetry. Transparent + less capable > opaque + more capable.", confidence: 0.85 },
  { topic: "Detection aggressive, intervention conservative", position: "Costs are asymmetric: missed detection = one more cycle; wrong intervention = destroyed valid state.", confidence: 0.75 },
  { topic: "Target-mechanism match", position: "Before investing more effort, audit whether the mechanism structurally reaches the target.", confidence: 0.75 },
  { topic: "Moat as three-legged stool", position: "Convenience (40%), Accumulated research (30%), Calibration (30%). Calibration creates highest switching cost.", confidence: 0.65 },
  { topic: "Trust phases (TP → CoS)", position: "Chief of Staff and Thinking Partner are phases of trust, not separate markets. TP-first = higher switching costs.", confidence: 0.70 },
  { topic: "Rate-constrained not cost-constrained", position: "Constraint = rate limits, not dollars. Maximize value per cloud call, not minimize cost.", confidence: 0.70 },
  { topic: "Self-correction 5-level spectrum", position: "L0 none → L5 autonomous. 100% of behavioral corrections discovered by Daniel, 0% autonomous. Human oracle irreplaceable.", confidence: 0.75 },
];

// Build set of existing topics for idempotent import
const existing = listPositions(db, {});
const existingTopics = new Set(existing.map(p => p.topic));

let imported = 0;
let skipped = 0;
for (const p of positions) {
  if (existingTopics.has(p.topic)) {
    skipped++;
    continue;
  }
  try {
    addPosition(db, p);
    imported++;
  } catch (e: any) {
    console.error(`Failed: ${p.topic} — ${e.message}`);
  }
}

console.log(`Imported ${imported}, skipped ${skipped} (already exist), of ${positions.length} positions`);
console.log(`Total positions in DB: ${existing.length + imported}`);
db.close();
