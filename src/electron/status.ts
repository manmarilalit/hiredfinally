// status.ts

interface PageSignals {
    url: string;
    bodyText: string;
    formCount: number;
    inputCount: number;
    fileInputCount: number;
    selectCount: number;
    textareaCount: number;
    buttonTexts: string[];
    hasProgressIndicator: boolean;
    requiredFieldCount: number;
    hasOverlay?:         boolean;
    hasResumeUpload?:    boolean;
    hasCompletionToast?: boolean;
    hasApplyButton?:     boolean;
}

interface DetectionResult {
    status: string;
    confidence: 'high' | 'medium' | 'low';
}

// -- Search/filter pages -- never IN_PROGRESS ---------------------------------
const SEARCH_PAGE_PATTERNS = [
    '/job-search', '/jobs/search', '/search/jobs', '/find-jobs',
    '/job-listings', '/explore',
    'indeed.com/jobs', 'indeed.com/rc/', 'indeed.com/viewjob',
    'linkedin.com/jobs/search', 'linkedin.com/jobs/collections',
    'glassdoor.com/job-listing', 'glassdoor.com/jobs-listing',
    'joinhandshake.com/explore', 'joinhandshake.com/job-search',
    'app.joinhandshake.com/explore', 'app.joinhandshake.com/job-search',
    'ziprecruiter.com/jobs',
    'dice.com/jobs',
    'wellfound.com/jobs',
    'monster.com/jobs',
];

const DEFINITE_APPLICATION_ENTRIES: Array<{ domain: string; pathMustInclude?: string }> = [
    { domain: 'smartapply.indeed.com' },
    { domain: 'indeedapply.com' },
    { domain: 'indeed.com',           pathMustInclude: '/applystart' },
    { domain: 'indeed.com',           pathMustInclude: '/apply' },
    { domain: 'greenhouse.io',        pathMustInclude: '/application' },
    { domain: 'boards.greenhouse.io', pathMustInclude: '/application' },
    { domain: 'app.greenhouse.io',    pathMustInclude: '/application' },
    { domain: 'lever.co',             pathMustInclude: '/apply' },
    { domain: 'jobs.lever.co',        pathMustInclude: '/apply' },
    { domain: 'myworkdayjobs.com',    pathMustInclude: '/apply' },
    { domain: 'workday.com',          pathMustInclude: '/applications' },
    { domain: 'icims.com',            pathMustInclude: '/applicant' },
    { domain: 'careers.icims.com',    pathMustInclude: '/applicant' },
    { domain: 'taleo.net',            pathMustInclude: '/careersection' },
    { domain: 'recruiting.ultipro.com' },
    { domain: 'jobvite.com',          pathMustInclude: '/apply' },
    { domain: 'jobs.jobvite.com',     pathMustInclude: '/apply' },
    { domain: 'apply.workable.com' },
    { domain: 'breezy.hr',            pathMustInclude: '/apply' },
    { domain: 'bamboohr.com',         pathMustInclude: '/apply' },
    { domain: 'hire.withgoogle.com' },
    { domain: 'paylocity.com',        pathMustInclude: '/recruiting' },
    { domain: 'jazz.co',              pathMustInclude: '/apply' },
    { domain: 'applicantpro.com' },
    { domain: 'recruitingbypaycor.com' },
];

const DEFINITE_COMPLETION_PATTERNS = [
    'smartapply.indeed.com/beta/indeedapply/form/application-submitted',
    'smartapply.indeed.com/beta/indeedapply/form/post-apply',
    '/application-submitted',
    '/apply/complete',
    '/apply/success',
    '/apply/confirmation',
    '/apply/thankyou',
    '/apply/thank-you',
    '/application/complete',
    '/application/success',
    '/application/confirmation',
    '/application/submitted',
];

function isSearchOrListingPage(url: string): boolean {
    const u = url.toLowerCase();
    return SEARCH_PAGE_PATTERNS.some(p => u.includes(p));
}

function isDefiniteApplicationPage(url: string): boolean {
    const uLower = url.toLowerCase();
    if (uLower.includes('post-apply'))    return false;
    if (uLower.includes('review-module')) return false;

    let hostname = '';
    let pathname = '';
    try {
        const parsed = new URL(url);
        hostname = parsed.hostname.toLowerCase();
        pathname = parsed.pathname.toLowerCase();
    } catch {
        return DEFINITE_APPLICATION_ENTRIES.some(e => {
            if (!uLower.includes(e.domain)) return false;
            return !e.pathMustInclude || uLower.includes(e.pathMustInclude);
        });
    }

    return DEFINITE_APPLICATION_ENTRIES.some(e => {
        if (!hostname.endsWith(e.domain) && hostname !== e.domain) return false;
        if (e.pathMustInclude && !pathname.includes(e.pathMustInclude)) return false;
        return true;
    });
}

function isDefiniteCompletionPage(url: string): boolean {
    const u = url.toLowerCase();
    return DEFINITE_COMPLETION_PATTERNS.some(p => u.includes(p));
}

const HIGH_CONFIDENCE_COMPLETION_PHRASES = [
    'application submitted successfully',
    'your application has been submitted',
    'application received successfully',
    'thank you for submitting your application',
    'successfully submitted your application',
    'your application is complete',
    'application has been received',
    'we have received your application',
    'you have successfully applied',
    'submission confirmed',
    'submission successful',
    'application confirmation',
    'successfully applied for',
    'application submitted',
    'application received',
    'application complete',
    'submission received',
];

const MEDIUM_CONFIDENCE_COMPLETION_PHRASES = [
    'thank you for applying',
    'thanks for applying',
    'thank you for your application',
    'thanks for your interest',
    "we'll be in touch",
    "we will review your application",
    "we'll review your application",
    "we will be in touch",
    'your application is being reviewed',
    'application is under review',
    'reviewing your application',
    'you will hear from us',
    'expect to hear from us',
];

function detectApplicationStatus(signals: PageSignals): DetectionResult {
    const urlLower  = signals.url.toLowerCase();
    const bodyLower = signals.bodyText.toLowerCase();

    if (isDefiniteCompletionPage(signals.url)) {
        return { status: 'COMPLETED', confidence: 'high' };
    }
    if (signals.hasCompletionToast) {
        return { status: 'COMPLETED', confidence: 'high' };
    }
    if (isDefiniteApplicationPage(signals.url)) {
        return { status: 'IN_PROGRESS', confidence: 'high' };
    }
    if (signals.hasResumeUpload && signals.hasOverlay) {
        return { status: 'IN_PROGRESS', confidence: 'high' };
    }

    const onSearchPage = isSearchOrListingPage(signals.url);

    const completedResult = checkCompletedStatus(signals, urlLower, bodyLower);
    if (completedResult) return completedResult;

    if (!onSearchPage) {
        const inProgressResult = checkInProgressStatus(signals, urlLower, bodyLower);
        if (inProgressResult) return inProgressResult;
    }

    const notStartedResult = checkNotStartedStatus(signals, urlLower, bodyLower);
    if (notStartedResult) return notStartedResult;

    return { status: 'UNKNOWN', confidence: 'low' };
}

function checkCompletedStatus(
    signals: PageSignals,
    urlLower: string,
    bodyLower: string,
): DetectionResult | null {

    const completionUrlPatterns = [
        '/confirmation', '/success', '/complete', '/thankyou', '/thank-you',
        '/submitted', '/application-confirmation', '/application-complete',
        '/application-submitted', '/application-success', '/submit-success',
        '/submission-complete', 'status=submitted', 'status=complete',
        'applicationsubmitted=true',
    ];
    const hasCompletionUrl = completionUrlPatterns.some(p => urlLower.includes(p));

    const confirmationIdentifiers = [
        'confirmation number', 'confirmation code', 'application number',
        'application id', 'reference number', 'application reference',
        'tracking number', 'submission id',
    ];

    const foundHigh       = HIGH_CONFIDENCE_COMPLETION_PHRASES.some(p => bodyLower.includes(p));
    const foundMedium     = MEDIUM_CONFIDENCE_COMPLETION_PHRASES.some(p => bodyLower.includes(p));
    const foundIdentifier = confirmationIdentifiers.some(p => bodyLower.includes(p));

    const hasCheckmark   = /checkmark|check-mark|&#10003;|&#x2713;/.test(bodyLower);
    const hasSuccess     = /success!/i.test(bodyLower);
    const noFormsPresent = signals.formCount === 0 ||
                           (signals.formCount === 1 && signals.inputCount <= 3 && signals.requiredFieldCount === 0);
    const hasApplyButton = signals.buttonTexts.some(t => t.includes('apply') || t.includes('submit application'));
    const hasHeavyForm   = signals.fileInputCount > 0 || signals.textareaCount > 2 || signals.requiredFieldCount > 5;

    if (hasCompletionUrl && foundHigh)                                           return { status: 'COMPLETED', confidence: 'high' };
    if (foundHigh && foundIdentifier)                                            return { status: 'COMPLETED', confidence: 'high' };
    if (foundHigh && noFormsPresent)                                             return { status: 'COMPLETED', confidence: 'high' };
    if (foundHigh && (hasCheckmark || hasSuccess))                               return { status: 'COMPLETED', confidence: 'high' };
    if (hasCompletionUrl && (foundMedium || foundIdentifier) && !hasApplyButton) return { status: 'COMPLETED', confidence: 'high' };
    if (foundMedium && hasCompletionUrl && noFormsPresent)                       return { status: 'COMPLETED', confidence: 'medium' };
    if (foundMedium && foundIdentifier && !hasHeavyForm)                         return { status: 'COMPLETED', confidence: 'medium' };
    if (hasCompletionUrl && noFormsPresent && (hasCheckmark || hasSuccess))      return { status: 'COMPLETED', confidence: 'medium' };

    return null;
}

function checkInProgressStatus(
    signals: PageSignals,
    urlLower: string,
    bodyLower: string,
): DetectionResult | null {

    if (signals.hasApplyButton && !signals.hasResumeUpload) return null;

    if (signals.hasOverlay) {
        const overlayHasRealFormContent =
            signals.fileInputCount >= 1 ||
            signals.requiredFieldCount >= 1 ||
            signals.textareaCount >= 1 ||
            (signals.inputCount >= 3 && !signals.buttonTexts.some(t =>
                t.includes('apply now') || t.includes('easy apply') || t.includes('quick apply')
            ));
        if (overlayHasRealFormContent) {
            return { status: 'IN_PROGRESS', confidence: 'high' };
        }
    }

    const applicationUrlPatterns = [
        '/apply', '/application/', '/applicant', '/candidate',
        '/job-application', '/careers/application', '/onboarding',
        '/apply-now', '/job/apply', '/positions/apply', '/vacancy/apply',
        'applyform', '/assessment',
    ];
    const hasApplicationUrl = applicationUrlPatterns.some(p => urlLower.includes(p));

    const hardExcluded =
        ['/explore', '/job-search', '/search', '/jobs?'].some(p => urlLower.includes(p)) &&
        signals.requiredFieldCount === 0 && !signals.hasOverlay;
    if (hardExcluded) return null;

    const hasFileInput       = signals.fileInputCount >= 1;
    const hasManyInputs      = signals.inputCount >= 5;
    const hasMultipleSelects = signals.selectCount >= 2;
    const hasTextarea        = signals.textareaCount >= 1;
    const hasAnyRequired     = signals.requiredFieldCount >= 1;
    const hasManyRequired    = signals.requiredFieldCount >= 3;
    const hasProgress        = signals.hasProgressIndicator;

    const hasNextButton = signals.buttonTexts.some(t =>
        t.includes('next') || t.includes('continue') ||
        t.includes('save and continue') || t.includes('proceed') ||
        t.includes('next step')
    );
    const hasSubmitButton = signals.buttonTexts.some(t =>
        t.includes('submit') || t.includes('submit application') ||
        t.includes('send application') || t.includes('complete application') ||
        t.includes('finish')
    );
    const hasApplyNowButton = signals.buttonTexts.some(t =>
        t.includes('apply now') || t.includes('easy apply') || t.includes('quick apply')
    );
    const inFormContext = !hasApplyNowButton && (hasSubmitButton || hasNextButton);

    const applicationKeywords = [
        'work experience', 'employment history', 'education', 'educational background',
        'cover letter', 'references', 'skills', 'certifications', 'work authorization',
        'eligible to work', 'start date', 'availability', 'salary expectations',
        'desired salary', 'demographic information', 'veteran status', 'disability status',
        'equal opportunity', 'previous employment', 'current employer', 'job history',
        'qualifications', 'licenses', 'portfolio', 'linkedin profile', 'professional summary',
        'voluntary self-identification', 'affirmative action', 'gender identity',
        'race/ethnicity', 'date available', 'desired pay',
    ];
    const foundKeywords     = applicationKeywords.filter(kw => bodyLower.includes(kw));
    const hasStrongKeywords = foundKeywords.length >= 2;
    const hasSomeKeywords   = foundKeywords.length >= 1;

    const formsAreMeaningful = hasAnyRequired || hasFileInput;

    let score = 0;
    if (hasFileInput)                              score += 3;
    if (hasManyRequired)                           score += 3;
    if (hasAnyRequired)                            score += 1;
    if (hasManyInputs && formsAreMeaningful)       score += 1;
    if (hasMultipleSelects && formsAreMeaningful)  score += 1;
    if (hasTextarea)                               score += 1;
    if (hasProgress)                               score += 1;
    if (hasNextButton)                             score += 1;
    if (hasSubmitButton && inFormContext)           score += 2;
    if (hasStrongKeywords)                         score += 2;
    if (hasSomeKeywords && formsAreMeaningful)     score += 1;
    if (hasApplicationUrl)                         score += 1;

    if (!formsAreMeaningful && !hasStrongKeywords && !inFormContext) return null;

    if (hasFileInput && hasApplicationUrl && hasStrongKeywords)              return { status: 'IN_PROGRESS', confidence: 'high' };
    if (hasFileInput && hasManyRequired)                                      return { status: 'IN_PROGRESS', confidence: 'high' };
    if (hasApplicationUrl && score >= 7)                                      return { status: 'IN_PROGRESS', confidence: 'high' };
    if (score >= 9)                                                           return { status: 'IN_PROGRESS', confidence: 'high' };
    if (hasFileInput && hasStrongKeywords)                                    return { status: 'IN_PROGRESS', confidence: 'high' };
    if (hasApplicationUrl && hasNextButton && hasAnyRequired)                 return { status: 'IN_PROGRESS', confidence: 'high' };
    if (score >= 7)                                                           return { status: 'IN_PROGRESS', confidence: 'high' };
    if (hasApplicationUrl && score >= 4)                                      return { status: 'IN_PROGRESS', confidence: 'medium' };
    if (hasStrongKeywords && score >= 5)                                      return { status: 'IN_PROGRESS', confidence: 'medium' };
    if (hasSubmitButton && hasManyRequired && hasManyInputs && inFormContext) return { status: 'IN_PROGRESS', confidence: 'medium' };
    if (hasSubmitButton && inFormContext && hasSomeKeywords && hasManyInputs) return { status: 'IN_PROGRESS', confidence: 'medium' };
    if (hasSubmitButton && inFormContext && hasSomeKeywords)                  return { status: 'IN_PROGRESS', confidence: 'low' };

    return null;
}

function checkNotStartedStatus(
    signals: PageSignals,
    urlLower: string,
    bodyLower: string,
): DetectionResult | null {

    if (signals.hasOverlay && (signals.inputCount >= 3 || signals.requiredFieldCount >= 1)) {
        return null;
    }

    const jobListingUrlPatterns = [
        '/job/', '/jobs/', '/viewjob', '/joblisting', '/posting/', '/postings/',
        '/vacancy/', '/vacancies/', '/position/', '/positions/', '/career/', '/careers/',
        '/rc/clk', '/pagead/clk',
        'indeed.com/viewjob', 'indeed.com/rc/',
        'linkedin.com/jobs/view',
        'glassdoor.com/job', 'glassdoor.com/job-listing',
        'monster.com/job-opening', 'ziprecruiter.com/c/', 'ziprecruiter.com/jobs/',
        'simplyhired.com/job', 'dice.com/jobs/detail', 'careerbuilder.com/job/',
        'usajobs.gov/job/',
        'joinhandshake.com/jobs/', 'app.joinhandshake.com/jobs/',
        'joinhandshake.com/job-search/', 'app.joinhandshake.com/job-search/',
    ];
    const hasJobListingUrl = jobListingUrlPatterns.some(p => urlLower.includes(p));

    const hasApplyButton = signals.hasApplyButton !== undefined
        ? signals.hasApplyButton
        : signals.buttonTexts.some(t =>
            ['apply now', 'easy apply', 'quick apply', 'apply on', 'apply at',
             'start application', 'apply for this job', 'apply for job', 'apply to',
             'apply for this position', 'begin application', 'start applying',
             'continue to application', 'apply with', 'apply externally',
             'apply on handshake'].some(a => t.includes(a))
          );

    const jobDescKeywords = [
        'job description', 'job summary', 'position summary', 'about the role',
        'about this job', 'about the position', "what you'll do", 'responsibilities',
        'key responsibilities', 'job responsibilities', 'required qualifications',
        'requirements', 'job requirements', 'preferred qualifications',
        'skills required', 'experience required', 'education required',
        "what we're looking for", 'ideal candidate', 'we are looking for',
    ];
    const foundJobKeywords  = jobDescKeywords.filter(kw => bodyLower.includes(kw));
    const hasJobDescContent = foundJobKeywords.length >= 2;
    const hasSomeJobContent = foundJobKeywords.length >= 1;

    const hasJobMetadata = [
        'job type', 'employment type', 'full-time', 'part-time', 'contract',
        'salary range', 'pay range', 'compensation', 'posted', 'location',
        'remote', 'hybrid', 'on-site', 'job id', 'requisition',
    ].some(kw => bodyLower.includes(kw));

    const hasEmployerInfo = [
        'about the company', 'about us', 'company overview', 'company description',
    ].some(kw => bodyLower.includes(kw));

    const noApplicationElements = signals.fileInputCount === 0 &&
                                   signals.textareaCount <= 1 &&
                                   signals.requiredFieldCount <= 2;

    const hasMinimalForms = signals.formCount <= 2 &&
                            signals.inputCount < 10 &&
                            signals.fileInputCount === 0;

    const looksLikeForm = signals.requiredFieldCount >= 3 && signals.inputCount >= 5;

    const hasSaveButton  = signals.buttonTexts.some(t => t.includes('save') || t.includes('bookmark') || t.includes('save job'));
    const hasShareButton = signals.buttonTexts.some(t => t.includes('share') || t.includes('share job'));

    let score = 0;
    if (hasJobListingUrl)      score += 2;
    if (hasApplyButton)        score += 2;
    if (hasJobDescContent)     score += 2;
    if (hasSomeJobContent)     score += 1;
    if (hasJobMetadata)        score += 1;
    if (hasEmployerInfo)       score += 1;
    if (hasSaveButton)         score += 1;
    if (hasShareButton)        score += 1;
    if (noApplicationElements) score += 2;
    if (hasMinimalForms)       score += 1;

    if (looksLikeForm && !hasApplyButton) return null;

    if (hasApplyButton && noApplicationElements)                                        return { status: 'NOT_STARTED', confidence: 'high' };
    if (hasJobListingUrl && hasJobDescContent && hasApplyButton)                        return { status: 'NOT_STARTED', confidence: 'high' };
    if (hasJobListingUrl && hasJobDescContent && noApplicationElements)                 return { status: 'NOT_STARTED', confidence: 'high' };
    if (score >= 8 && noApplicationElements)                                            return { status: 'NOT_STARTED', confidence: 'high' };
    if (hasApplyButton && hasSomeJobContent && hasMinimalForms)                         return { status: 'NOT_STARTED', confidence: 'high' };
    if (hasJobListingUrl && score >= 5 && hasMinimalForms)                              return { status: 'NOT_STARTED', confidence: 'medium' };
    if (hasJobDescContent && noApplicationElements && hasMinimalForms)                  return { status: 'NOT_STARTED', confidence: 'medium' };
    if ((hasSaveButton || hasShareButton) && hasJobListingUrl && noApplicationElements) return { status: 'NOT_STARTED', confidence: 'medium' };

    return null;
}

module.exports = { detectApplicationStatus, isDefiniteApplicationPage };