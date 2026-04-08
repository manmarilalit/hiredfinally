# Job Board Aggregator Exclusions

## Problem
GitHub job listing repositories (like SimplifyJobs/Summer2026-Internships) were being incorrectly detected as COMPLETED applications because:
- GitHub has overlay elements (notification bell)
- GitHub has "completion toast" UI elements
- GitHub has progress indicators

This caused:
- False "Application submitted" notifications
- Incorrect tracking of GitHub pages as completed applications
- Duplicate notifications every time you visited the page

## Solution
Added a new pipeline stage that excludes job board aggregators from detection entirely.

### Excluded Sites
The following sites are now excluded from application tracking:

1. **GitHub Job Lists**
   - `github.com/SimplifyJobs/*`
   - `github.com/ReaVNaiL/*`
   - `github.com/pittcsc/*`

2. **Job Aggregators**
   - `simplify.jobs`
   - `levels.fyi`

3. **Community Forums**
   - `reddit.com/r/cscareerquestions`

### How It Works

#### Stage 0: Exclude Job Board Aggregators
- Runs FIRST in the detection pipeline (before any other checks)
- Checks if URL matches any aggregator pattern
- If match found:
  - Returns `UNKNOWN` status with `low` confidence
  - Short-circuits the pipeline (stops all other checks)
  - No tracking, no notifications, no database entries

#### Double Protection
1. **Detection Pipeline**: Returns UNKNOWN immediately
2. **Tracking Exclusion**: `isExcludedFromTracking()` also blocks these URLs

### Code Changes

**src/electron/status.ts**:
```typescript
// New exclusion list
const JOB_BOARD_AGGREGATORS: string[] = [
    'github.com/SimplifyJobs',
    'github.com/ReaVNaiL',
    'github.com/pittcsc',
    'simplify.jobs',
    'levels.fyi',
    'reddit.com/r/cscareerquestions',
];

// New pipeline stage (runs first)
function stageExcludeJobBoardAggregators(ctx: PipelineContext): void {
    const { urlLower } = ctx;
    const isAggregator = JOB_BOARD_AGGREGATORS.some(pattern => 
        urlLower.includes(pattern.toLowerCase())
    );
    
    if (isAggregator) {
        ctx.result = { status: 'UNKNOWN', confidence: 'low' };
        ctx.shortCircuit = true;
    }
}
```

**src/electron/index.ts**:
```typescript
function isExcludedFromTracking(url: string): boolean {
    const u = url.toLowerCase();
    return (
      // ... existing exclusions ...
      /github\.com\/SimplifyJobs/i.test(u) ||
      /github\.com\/ReaVNaiL/i.test(u) ||
      /github\.com\/pittcsc/i.test(u) ||
      /simplify\.jobs/i.test(u) ||
      /levels\.fyi/i.test(u)
    );
}
```

## Result

Now when you visit GitHub job lists:
- ✅ No detection attempts
- ✅ No false COMPLETED status
- ✅ No notifications
- ✅ No database entries
- ✅ Status stays as "Not tracking"

## Adding More Exclusions

To exclude additional job board aggregators:

1. Add the domain pattern to `JOB_BOARD_AGGREGATORS` in `src/electron/status.ts`
2. Add a regex pattern to `isExcludedFromTracking()` in `src/electron/index.ts`
3. Rebuild: `npm run build`

Example:
```typescript
// In status.ts
const JOB_BOARD_AGGREGATORS: string[] = [
    // ... existing ...
    'newjobboard.com',
];

// In index.ts
function isExcludedFromTracking(url: string): boolean {
    return (
      // ... existing ...
      /newjobboard\.com/i.test(u)
    );
}
```

## Testing

After the fix, visiting GitHub job lists should show in logs:
```
[4/4/2026, 6:54:03 PM] UNKNOWN (low)
  Current Status: NOT_STARTED
  URL: https://github.com/SimplifyJobs/Summer2026-Internships
  
  Applied: NO
```

No status change, no notification, no tracking.
