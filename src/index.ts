// Core DB
export {
  initDb,
  runMigration,
  resolveId,
} from './db.js';

// F9 — Corrections (self-verification)
export {
  initCorrections,
  addCorrection,
  getCorrection,
  listCorrections,
  searchCorrections,
  recordViolation,
  graduateCorrection,
  deleteCorrection,
  getContext,
  getStats,
} from './corrections.js';

export type {
  Correction,
  CorrectionType,
  Permanence,
  AddCorrectionInput,
} from './corrections.js';

// F1 — Beliefs
export {
  initBeliefs,
  addBelief,
  getBelief,
  listBeliefs,
  checkObservation,
  recordContradiction,
  confirmBelief,
  reviseBelief,
  retireBelief,
  getBeliefContext,
  getBeliefStats,
  SENSITIVITY_THRESHOLDS,
  hasConflictingNumericValues,
  containsNegation,
  parseApproxNumber,
} from './beliefs.js';

export type {
  Belief,
  BeliefCategory,
  BeliefStatus,
  BeliefSensitivity,
  AddBeliefInput,
  ListBeliefsOpts,
  CheckObservationResult,
  BeliefStats,
} from './beliefs.js';

// F9 — Predictions
export {
  initPredictions,
  addPrediction,
  getPrediction,
  listPredictions,
  revisePrediction,
  resolvePrediction,
  getPendingReview,
  getCalibration,
} from './predictions.js';

export type {
  Prediction,
  PredictionRevision,
  Domain,
  Outcome,
  AddPredictionInput,
  ListPredictionsOpts,
  CalibrationResult,
} from './predictions.js';

// F9 — Positions
export {
  initPositions,
  addPosition,
  getPosition,
  listPositions,
  challengePosition,
  revisePosition,
  abandonPosition,
  getUnchallenged,
  getPositionContext,
} from './positions.js';

export type {
  Position,
  PositionStatus,
  AddPositionInput,
} from './positions.js';

// F9 — Calibration
export {
  brierScore,
  calibrationByDomain,
  getSystematicBias,
  calibrationReport,
} from './calibration.js';

export type {
  BiasAnalysis,
  CalibrationReportData,
} from './calibration.js';

// L2.5 — Epistemic Digest
export { compileDigest } from './digest.js';
export type { DigestOpts, DigestResult, DigestStats } from './digest.js';

// F9 — Adversarial Verification
export {
  initVerifications,
  createVerification,
  getVerification,
  verificationTick,
  opportunisticVerification,
  recordVerification,
  skipVerification,
  getBeliefVerifications,
  verificationStatus,
} from './verification.js';

export type {
  Verification,
  VerificationStatus,
  VerificationOutcome,
  VerificationStrategy,
  VerificationTickItem,
  VerificationTickResult,
  VerificationStats,
} from './verification.js';

// F6+F10 — Unified Knowledge Store
export {
  initKnowledge,
  addKnowledge,
  getKnowledge,
  getKnowledgeByKey,
  listKnowledge,
  listKnowledgeInternal,
  updateKnowledge,
  upsertKnowledge,
  deleteKnowledge,
  deleteKnowledgeByType,
  searchKnowledge,
  getKnowledgeStats,
  importBeliefsToKnowledge,
  importCorrectionsToKnowledge,
  importPositionsToKnowledge,
  importPredictionsToKnowledge,
  importAllToKnowledge,
  MetadataFilter,
  OrderBy,
} from './knowledge.js';

export type {
  Knowledge,
  KnowledgeType,
  AddKnowledgeInput,
  ListKnowledgeOpts,
  ListKnowledgeInternalOpts,
  MetadataFilter as MetadataFilterType,
  OrderByExpr,
} from './knowledge.js';

// Dashboard
export { getDashboardData, startDashboard } from './dashboard.js';
export type { DashboardData } from './dashboard.js';

// F10 — Context Compiler
export {
  assembleContext,
} from './compiler.js';

export type {
  AssembleContextOpts,
  AssembleContextResult,
  MaintenanceItems,
} from './compiler.js';
