// F9 — Corrections (self-verification)
export {
  initDb,
  addCorrection,
  getCorrection,
  listCorrections,
  recordViolation,
  graduateCorrection,
  deleteCorrection,
  getContext,
  getStats,
} from './db.js';

export type {
  Correction,
  CorrectionType,
  Permanence,
  AddCorrectionInput,
} from './db.js';

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
} from './beliefs.js';

export type {
  Belief,
  BeliefCategory,
  BeliefStatus,
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
  resolvePrediction,
  getPendingReview,
  getCalibration,
} from './predictions.js';

export type {
  Prediction,
  Domain,
  Outcome,
  AddPredictionInput,
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

// F7 — Events
export {
  initEvents,
  logEvent,
  logSessionStart,
  logSessionEnd,
  logMessageReceived,
  getRecentEvents,
  getActiveSessions,
  pruneOldEvents,
  getEventStats,
} from './events.js';

export type {
  Event,
  ActiveSession,
  EventStats,
} from './events.js';

// F7 — Awareness
export {
  compileAwarenessContext,
  getConcurrentSessionHint,
} from './awareness.js';

export type {
  AwarenessOpts,
} from './awareness.js';

// F2 — Learning
export {
  extractUrls,
  extractBeliefs,
  extractTopics,
  extractCorrections,
} from './learning.js';

export type {
  ExtractedBelief,
  ExtractedTopic,
  ExtractedCorrection,
} from './learning.js';

// F3+F4 — Metacognition
export {
  analyzeCycling,
  getCyclingIntervention,
  categorizeContent,
  calculateAlignmentScore,
  analyzeAttentionBudget,
} from './metacognition.js';

export type {
  TextEntry,
  CyclingAnalysis,
  AttentionCategory,
  AttentionAnalysis,
} from './metacognition.js';

// F5 — Distillation
export {
  classifyLine,
  extractSignal,
  buildDigest,
  compactLog,
  getRecurringThemes,
} from './distill.js';

// F9 — Adversarial Verification
export {
  initVerifications,
  createVerification,
  getVerification,
  verificationTick,
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
  searchKnowledgeHybrid,
  getKnowledgeStats,
  importBeliefsToKnowledge,
  importCorrectionsToKnowledge,
  importPositionsToKnowledge,
  importPredictionsToKnowledge,
  importAllToKnowledge,
  importChunksToKnowledge,
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
  EmbedFn,
} from './knowledge.js';

// F10 — Context Compiler
export {
  assembleContext,
  DEFAULT_SESSION_LAYERS,
} from './compiler.js';

export type {
  SessionType,
  SessionLayerItem,
  AssembleContextOpts,
  AssembleContextResult,
} from './compiler.js';
