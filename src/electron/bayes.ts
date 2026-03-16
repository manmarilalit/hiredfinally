// bayes.ts
//
// Naive Bayes scorer for application page detection.
//
// HOW IT WORKS:
//   Every time a page is detected and confirmed (auto or manual), we store a
//   feature snapshot alongside the outcome in job_apps_features. Over time we
//   accumulate P(feature | outcome) for each outcome class. When scoring a new
//   page we combine those probabilities to get P(outcome | features) and return
//   the most likely class with a confidence level.
//
//   This replaces the magic numbers in stageInProgressScoring with weights that
//   are derived from your actual observed data — the detector improves
//   automatically as you use the app.
//
// MATH:
//   Naive Bayes assumes features are conditionally independent given the class.
//   For each class C and feature set F:
//
//     log P(C | F) ∝ log P(C) + Σ log P(f_i | C)
//
//   We work in log space to avoid floating point underflow when multiplying
//   many small probabilities together.
//
//   Laplace smoothing (adding 1 to all counts) prevents zero probabilities
//   when a feature has never been seen with a given class.
//
// INTEGRATION:
//   - Call recordFeatures(url, features, outcome) when a status is confirmed
//   - Call bayesScore(features) in stageInProgressScoring as a supplement
//     to the existing rule-based score
//   - Call getBayesStats() to inspect what the model has learned
//
// DATABASE:
//   Adds one table: job_apps_features
//   Does not modify any existing tables.

const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PageFeatures {
    // Form structure
    hasFileInput: boolean;
    hasManyRequired: boolean;  // >= 3
    hasAnyRequired: boolean;  // >= 1
    hasManyInputs: boolean;  // >= 5
    hasMultipleSelects: boolean;  // >= 2
    hasTextarea: boolean;
    hasProgress: boolean;
    // Buttons
    hasNextButton: boolean;
    hasSubmitButton: boolean;
    hasApplyButton: boolean;
    hasApplyNowButton: boolean;  // "apply now", "easy apply" etc.
    // URL signals
    hasApplicationUrl: boolean;  // /apply, /application/, /careers/ etc.
    hasJobListingUrl: boolean;  // /jobs/, /job/, /viewjob etc.
    hasCompletionUrl: boolean;  // /confirmation, /success etc.
    isDefiniteAtsUrl: boolean;  // greenhouse, lever etc.
    // Content signals
    hasStrongKeywords: boolean;  // >= 2 application keywords
    hasSomeKeywords: boolean;  // >= 1 application keyword
    hasJobDescContent: boolean;  // >= 2 job description keywords
    hasCompletionPhrase: boolean;  // "application submitted" etc.
    hasResumeUpload: boolean;
    hasOverlay: boolean;
}

export type OutcomeClass = 'IN_PROGRESS' | 'COMPLETED' | 'NOT_STARTED';

export interface BayesResult {
    predictedClass: OutcomeClass;
    confidence: 'high' | 'medium' | 'low';
    probabilities: Record<OutcomeClass, number>;  // normalised 0–1
    sampleSize: number;  // how many training examples were used
    reliable: boolean; // false if not enough data yet
}

// ── Constants ─────────────────────────────────────────────────────────────────

// Canonical feature key list — derived from a typed object so the keys
// are guaranteed to match PageFeatures exactly.
const _FEATURE_TEMPLATE: Record<keyof PageFeatures, boolean> = {
    hasFileInput: false, hasManyRequired: false, hasAnyRequired: false,
    hasManyInputs: false, hasMultipleSelects: false, hasTextarea: false,
    hasProgress: false, hasNextButton: false, hasSubmitButton: false,
    hasApplyButton: false, hasApplyNowButton: false, hasApplicationUrl: false,
    hasJobListingUrl: false, hasCompletionUrl: false, isDefiniteAtsUrl: false,
    hasStrongKeywords: false, hasSomeKeywords: false, hasJobDescContent: false,
    hasCompletionPhrase: false, hasResumeUpload: false, hasOverlay: false,
};
const FEATURE_KEYS = Object.keys(_FEATURE_TEMPLATE) as (keyof PageFeatures)[];

const CLASSES: OutcomeClass[] = ['IN_PROGRESS', 'COMPLETED', 'NOT_STARTED'];

// Minimum number of training examples before we trust the model.
// Below this threshold bayesScore returns reliable: false and the
// pipeline falls back to the rule-based scorer.
const MIN_RELIABLE_SAMPLES = 20;

// Confidence thresholds on the winning class's normalised probability
const HIGH_CONFIDENCE_THRESHOLD = 0.75;
const MEDIUM_CONFIDENCE_THRESHOLD = 0.55;

// ── Database setup ────────────────────────────────────────────────────────────

let _db: any = null;

function getDb(): any {
    if (_db) return _db;
    const dbPath = app.isPackaged
        ? path.join(app.getPath('userData'), 'job_apps.db')
        : './src/electron/job_apps.db';
    _db = new Database(dbPath);
    _db.exec(`
        CREATE TABLE IF NOT EXISTS job_apps_features (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            url         TEXT NOT NULL,
            outcome     TEXT NOT NULL,
            recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
            ${FEATURE_KEYS.map(k => `f_${k} INTEGER NOT NULL DEFAULT 0`).join(',\n            ')}
        )
    `);
    // Index for fast class counting
    try {
        _db.exec(`CREATE INDEX IF NOT EXISTS idx_jaf_outcome ON job_apps_features(outcome)`);
    } catch { /* already exists */ }
    return _db;
}

// ── Feature recording ─────────────────────────────────────────────────────────

/**
 * Record a confirmed outcome alongside its features.
 * Call this whenever a status transition is confirmed — auto-detected or manual.
 *
 * Example:
 *   recordFeatures(url, extractFeatures(signals), 'IN_PROGRESS')
 */
export function recordFeatures(
    url: string,
    features: PageFeatures,
    outcome: OutcomeClass,
): void {
    try {
        const db = getDb();
        const cols = FEATURE_KEYS.map(k => `f_${k}`).join(', ');
        const vals = FEATURE_KEYS.map(k => features[k] ? 1 : 0).join(', ');
        db.prepare(`
            INSERT INTO job_apps_features (url, outcome, ${cols})
            VALUES (?, ?, ${vals})
        `).run(url, outcome);
    } catch (err) {
        console.error('[BAYES] recordFeatures error:', err);
    }
}

// ── Model: count-based Naive Bayes ────────────────────────────────────────────

interface ClassStats {
    total: number;                           // rows with this class
    featureCounts: Record<keyof PageFeatures, number>; // rows where feature=true
}

function loadClassStats(): Record<OutcomeClass, ClassStats> | null {
    try {
        const db = getDb();
        const rows = db.prepare(`SELECT * FROM job_apps_features`).all() as any[];
        if (rows.length < MIN_RELIABLE_SAMPLES) return null;

        const stats: Record<string, ClassStats> = {};
        for (const cls of CLASSES) {
            const empty: any = {};
            for (const k of FEATURE_KEYS) empty[k] = 0;
            stats[cls] = { total: 0, featureCounts: empty };
        }

        for (const row of rows) {
            const cls = row.outcome as OutcomeClass;
            if (!stats[cls]) continue;
            stats[cls].total++;
            for (const k of FEATURE_KEYS) {
                if (row[`f_${k}`] === 1) stats[cls].featureCounts[k]++;
            }
        }

        return stats as Record<OutcomeClass, ClassStats>;
    } catch (err) {
        console.error('[BAYES] loadClassStats error:', err);
        return null;
    }
}

// ── Scoring ───────────────────────────────────────────────────────────────────

/**
 * Score a feature vector using Naive Bayes.
 *
 * Returns null if there isn't enough training data yet — in that case
 * the pipeline should fall back to the rule-based scorer.
 */
export function bayesScore(features: PageFeatures): BayesResult | null {
    const stats = loadClassStats();
    if (!stats) return null;

    const totalSamples = CLASSES.reduce((s, c) => s + stats[c].total, 0);
    if (totalSamples < MIN_RELIABLE_SAMPLES) return null;

    // Compute log-posterior for each class:
    //   log P(C | F) ∝ log P(C) + Σ_i log P(f_i | C)
    //
    // Laplace smoothing: P(f | C) = (count(f,C) + 1) / (count(C) + 2)
    // The +2 in denominator accounts for both the true and false cases.

    const logScores = new Map<OutcomeClass, number>();

    for (const cls of CLASSES) {
        const s = stats[cls];
        const classN = s.total;
        // log prior
        let logScore = Math.log((classN + 1) / (totalSamples + CLASSES.length));

        for (const k of FEATURE_KEYS) {
            const featureCount = s.featureCounts[k];
            const featureVal = features[k];

            // P(feature=true  | C) with Laplace smoothing
            const pTrue = (featureCount + 1) / (classN + 2);
            // P(feature=false | C)
            const pFalse = 1 - pTrue;

            logScore += Math.log(featureVal ? pTrue : pFalse);
        }

        logScores.set(cls, logScore);
    }

    // Convert log scores → normalised probabilities via softmax
    const logValues = Array.from(logScores.values());
    const maxLog = Math.max(...logValues);
    const expScores = new Map<OutcomeClass, number>();
    let expSum = 0;

    for (const cls of CLASSES) {
        const exp = Math.exp(logScores.get(cls)! - maxLog);
        expScores.set(cls, exp);
        expSum += exp;
    }

    const probs = new Map<OutcomeClass, number>();
    for (const cls of CLASSES) {
        probs.set(cls, expScores.get(cls)! / expSum);
    }

    // Pick winner
    const predictedClass = CLASSES.reduce<OutcomeClass>(
        (best, cls) => (probs.get(cls)! > probs.get(best)!) ? cls : best,
        CLASSES[0]!
    );
    const winProb = probs.get(predictedClass)!;

    const confidence: 'high' | 'medium' | 'low' =
        winProb >= HIGH_CONFIDENCE_THRESHOLD ? 'high' :
            winProb >= MEDIUM_CONFIDENCE_THRESHOLD ? 'medium' : 'low';

    // Convert Map → plain object for the return type
    const probsObj = Object.fromEntries(probs) as Record<OutcomeClass, number>;

    return {
        predictedClass,
        confidence,
        probabilities: probsObj,
        sampleSize: totalSamples,
        reliable: true,
    };
}

// ── Feature extraction ────────────────────────────────────────────────────────
//
// Converts raw PageSignals into the flat boolean feature vector that the
// Bayes model operates on. Import this alongside bayesScore so that the
// same feature definitions are used for both recording and scoring.

const APPLICATION_KEYWORDS = [
    'work experience', 'employment history', 'education', 'educational background',
    'cover letter', 'references', 'skills', 'certifications', 'work authorization',
    'eligible to work', 'start date', 'availability', 'salary expectations',
    'desired salary', 'demographic information', 'veteran status', 'disability status',
    'equal opportunity', 'previous employment', 'current employer', 'job history',
    'qualifications', 'licenses', 'portfolio', 'linkedin profile', 'professional summary',
    'voluntary self-identification', 'affirmative action', 'gender identity',
    'race/ethnicity', 'date available', 'desired pay',
];

const JOB_DESC_KEYWORDS = [
    'job description', 'job summary', 'position summary', 'about the role',
    'about this job', 'about the position', "what you'll do", 'responsibilities',
    'key responsibilities', 'required qualifications', 'requirements',
    "what we're looking for", 'ideal candidate', 'we are looking for',
];

const COMPLETION_PHRASES = [
    'application submitted', 'application received', 'application complete',
    'successfully applied', 'your application has been submitted',
    'we have received your application', 'submission confirmed',
];

const APPLICATION_URL_PATTERNS = [
    '/apply', '/application/', '/applicant', '/candidate', '/careers/',
    '/job-application', '/onboarding', '/apply-now', '/job/apply',
    '/positions/apply', '/vacancy/apply', 'applyform', '/assessment',
];

const JOB_LISTING_URL_PATTERNS = [
    '/job/', '/jobs/', '/viewjob', '/posting/', '/postings/',
    '/vacancy/', '/vacancies/', '/position/', '/positions/',
    'linkedin.com/jobs/view', 'indeed.com/viewjob',
    'joinhandshake.com/jobs/',
];

const COMPLETION_URL_PATTERNS = [
    '/confirmation', '/success', '/complete', '/thankyou', '/thank-you',
    '/submitted', '/application-submitted', '/apply/success',
];

const DEFINITE_ATS_DOMAINS = [
    'greenhouse.io', 'lever.co', 'myworkdayjobs.com', 'workday.com',
    'icims.com', 'taleo.net', 'jobvite.com', 'apply.workable.com',
    'bamboohr.com', 'smartapply.indeed.com', 'indeedapply.com',
];

interface RawSignals {
    url: string;
    bodyText: string;
    buttonTexts: string[];
    formCount: number;
    inputCount: number;
    fileInputCount: number;
    selectCount: number;
    textareaCount: number;
    requiredFieldCount: number;
    hasProgressIndicator: boolean;
    hasOverlay?: boolean;
    hasResumeUpload?: boolean;
    hasCompletionToast?: boolean;
    hasApplyButton?: boolean;
}

export function extractFeatures(signals: RawSignals): PageFeatures {
    const urlLower = signals.url.toLowerCase();
    const bodyLower = signals.bodyText.toLowerCase();

    const appKeywordCount = APPLICATION_KEYWORDS.filter(k => bodyLower.includes(k)).length;
    const jobDescCount = JOB_DESC_KEYWORDS.filter(k => bodyLower.includes(k)).length;
    const hasCompletionPhr = COMPLETION_PHRASES.some(p => bodyLower.includes(p));

    const hasApplyNowBtn = signals.buttonTexts.some(t =>
        t.includes('apply now') || t.includes('easy apply') || t.includes('quick apply'));
    const hasNextBtn = signals.buttonTexts.some(t =>
        t.includes('next') || t.includes('continue') || t.includes('save and continue'));
    const hasSubmitBtn = signals.buttonTexts.some(t =>
        t.includes('submit') || t.includes('submit application') || t.includes('finish'));
    const hasApplyBtn = signals.hasApplyButton !== undefined
        ? signals.hasApplyButton
        : signals.buttonTexts.some(t =>
            ['apply now', 'easy apply', 'quick apply', 'apply on', 'apply at',
                'start application', 'apply for this job'].some(p => t.includes(p)));

    return {
        hasFileInput: signals.fileInputCount >= 1,
        hasManyRequired: signals.requiredFieldCount >= 3,
        hasAnyRequired: signals.requiredFieldCount >= 1,
        hasManyInputs: signals.inputCount >= 5,
        hasMultipleSelects: signals.selectCount >= 2,
        hasTextarea: signals.textareaCount >= 1,
        hasProgress: signals.hasProgressIndicator,
        hasNextButton: hasNextBtn,
        hasSubmitButton: hasSubmitBtn,
        hasApplyButton: hasApplyBtn,
        hasApplyNowButton: hasApplyNowBtn,
        hasApplicationUrl: APPLICATION_URL_PATTERNS.some(p => urlLower.includes(p)),
        hasJobListingUrl: JOB_LISTING_URL_PATTERNS.some(p => urlLower.includes(p)),
        hasCompletionUrl: COMPLETION_URL_PATTERNS.some(p => urlLower.includes(p)),
        isDefiniteAtsUrl: DEFINITE_ATS_DOMAINS.some(d => urlLower.includes(d)),
        hasStrongKeywords: appKeywordCount >= 2,
        hasSomeKeywords: appKeywordCount >= 1,
        hasJobDescContent: jobDescCount >= 2,
        hasCompletionPhrase: hasCompletionPhr || (signals.hasCompletionToast === true),
        hasResumeUpload: signals.hasResumeUpload === true,
        hasOverlay: signals.hasOverlay === true,
    };
}

// ── Inspection / debugging ────────────────────────────────────────────────────

export interface BayesStats {
    totalSamples: number;
    reliable: boolean;
    classCounts: Record<OutcomeClass, number>;
    // Top 5 most discriminative features per class
    topFeatures: Record<OutcomeClass, Array<{ feature: string; probability: number }>>;
}

/**
 * Returns a human-readable summary of what the model has learned.
 * Useful for debugging — log this periodically to see if the model
 * is learning sensible weights.
 */
export function getBayesStats(): BayesStats | null {
    const stats = loadClassStats();
    if (!stats) {
        return {
            totalSamples: 0,
            reliable: false,
            classCounts: { IN_PROGRESS: 0, COMPLETED: 0, NOT_STARTED: 0 },
            topFeatures: { IN_PROGRESS: [], COMPLETED: [], NOT_STARTED: [] },
        };
    }

    const totalSamples = CLASSES.reduce((s, c) => s + stats[c].total, 0);
    const classCounts = Object.fromEntries(
        CLASSES.map(c => [c, stats[c].total])
    ) as Record<OutcomeClass, number>;

    // For each class, rank features by P(feature=true | class)
    const topFeatures = Object.fromEntries(CLASSES.map(cls => {
        const s = stats[cls];
        const ranked = FEATURE_KEYS
            .map(k => ({
                feature: k,
                probability: (s.featureCounts[k] + 1) / (s.total + 2),
            }))
            .sort((a, b) => b.probability - a.probability)
            .slice(0, 5);
        return [cls, ranked];
    })) as Record<OutcomeClass, Array<{ feature: string; probability: number }>>;

    return { totalSamples, reliable: totalSamples >= MIN_RELIABLE_SAMPLES, classCounts, topFeatures };
}