// CI-failure classification (#172).
//
// The single highest-cost failure in the 2026-08-08 stall: PR #56 burned 7
// commits editing tests that were NEVER EXECUTED, because nothing distinguished
// a harness that failed to boot from tests that ran and failed. The CI it was
// reacting to said `Test Files  no tests` — a Node/undici version skew meant the
// vitest environment could not construct, so zero tests ran. The correct action
// was a one-line toolchain change; instead the fixer read "CI is red" and
// rewrote test files, repeatedly, until the watchdog parked the PR.
//
// A harness failure is IDENTICAL on every retry. Without classification, every
// harness break costs the full attempt budget and ends in a wrongly-parked PR —
// the engine spends maximum usage on the one class of failure it cannot fix by
// trying again. So we classify the red check BEFORE dispatching a fix, and tell
// the fixer what it is looking at.
//
// Pure over its input (a log string), like watchdog.ts / gates.ts, so the whole
// ladder is unit-testable without a `gh` binary. The IO — fetching the failing
// job's log — lives in github.ts (failingCiLog), and the wiring into the fix
// prompt lives in live.ts.

export type CiFailureClass = 'harness' | 'assertion' | 'infra' | 'static' | 'unknown';

// The environment/runner itself died — out of memory, killed, cancelled, disk
// full, a job-level timeout. Deliberately narrow: a PER-TEST timeout means a
// test actually ran, which is an assertion-class failure, so bare "timed out"
// is NOT here — only signals that the WHOLE run was torn down.
const INFRA = [
  /out of memory/i,
  /heap (?:limit|out of memory)/i,
  /javascript heap/i,
  /\bE?SIGKILL\b/i,
  /\bSIGTERM\b/i,
  /\bkilled\b.*\b(process|signal|runner)\b/i,
  /the runner has received a shutdown signal/i,
  /the operation was canceled/i,
  /no space left on device/i,
  /\bENOSPC\b/i,
  /\bECONNRESET\b/i,
  /\bETIMEDOUT\b/i,
  /has exceeded the maximum execution time/i,
  /lost communication with the server/i,
];

// The suite never RAN: it failed to construct, collect, import, or boot its
// environment, so zero tests executed. This is the class that must never be read
// as "tests failed" — the whole point of #172.
const HARNESS = [
  /\bno tests\b/i,                                  // vitest summary "Test Files  no tests"
  /no test (?:files? )?found/i,
  /0 (?:tests?|passed)\b(?![^]*\b[1-9]\d* passed)/i, // 0 ran and nothing later says N passed
  /cannot find module/i,
  /err_module_not_found/i,
  /cannot use import statement outside a module/i,
  /failed to (?:load|resolve|parse) (?:config|the config|url|module)/i,
  /transform failed/i,
  /could not resolve/i,
  /\bis not a function\b/i,                         // e.g. markAsUncloneable is not a function (env skew)
  /error: cannot find package/i,
  /unable to resolve/i,
  /module not found/i,
  /collecting tests? failed/i,
  /error while loading/i,
  /environment.*could not|could not.*environment/i,
];

// Tests ran, and one or more failed on an assertion / named case. These are real
// failures the fixer should act on.
const ASSERTION = [
  /assertion(?:error)?/i,
  /\bexpect\(/i,
  /expected .* (?:but )?(?:received|to (?:be|equal|deep))/i,
  /\b[1-9]\d* (?:failed|failing)\b/i,               // "3 failed"
  /\bFAIL\b/,
  /✕|✗|×/,
  /test timed out/i,                                // a test ran and hung — real, look at it
  /assert\b/i,
];

// A lint / typecheck / format failure with no test framework involved.
const STATIC = [
  /error TS\d{3,}/,
  /\beslint\b/i,
  /\bprettier\b/i,
  /\btslint\b/i,
  /\bruff\b/i,
  /\bflake8\b/i,
  /\bmypy\b/i,
  /\bpylint\b/i,
  /\bgolangci-lint\b/i,
  /type(?:check| error| checking)/i,
  /\btsc\b/i,
  /lint(?:ing)? (?:error|failed)/i,
  /✖ \d+ problems?/,            // eslint's stylish summary line
];

function anyMatch(log: string, res: RegExp[]): boolean {
  return res.some((re) => re.test(log));
}

// Did any test actually pass? "N passed" with N>0 proves the harness booted and
// the suite ran — so a stray import-error string later cannot demote it to
// "harness". This is the discriminator that keeps assertion from being misread.
function testsRan(log: string): boolean {
  return /\b[1-9]\d* (?:passed|passing|ok)\b/i.test(log)
    || /\btests?:\s*[1-9]/i.test(log);
}

/**
 * Classify a failing CI log into one of the four actionable classes (or
 * `unknown` when nothing matches — an empty or unrecognised log).
 *
 * Order encodes cost, not just specificity:
 *   1. infra    — the run was torn down; retrying is the fix, editing is not.
 *   2. harness  — the suite never ran; the toolchain is broken, NOT the tests.
 *                 Checked before assertion, and only when no test actually ran,
 *                 so an assertion log with a stray import string stays assertion.
 *   3. assertion— tests ran and failed; fix the code or the test.
 *   4. static   — lint/typecheck only; fix the reported lines.
 */
export function classifyCiFailure(log: string): CiFailureClass {
  const text = (log ?? '').trim();
  if (!text) return 'unknown';

  if (anyMatch(text, INFRA)) return 'infra';

  // A harness failure is defined by NOTHING having run. If the log shows real
  // passing tests, it booted — so any harness-looking string is incidental and
  // this is an assertion (or static) failure instead.
  if (!testsRan(text) && anyMatch(text, HARNESS)) return 'harness';

  if (anyMatch(text, ASSERTION)) return 'assertion';

  // Static only when there is no test-framework failure at all — a red typecheck
  // step next to failing tests is not what "static" means (the tests dominate).
  if (anyMatch(text, STATIC)) return 'static';

  return 'unknown';
}

// The instruction handed to the fixer for a given class — the load-bearing half.
// A `harness` fixer is explicitly forbidden from touching test bodies (the exact
// mistake that cost 7 commits); an `infra` fixer is told not to chase an
// environment outage with code; `unknown` returns no lines so the prompt keeps
// its existing generic guidance.
export function ciFixDirective(cls: CiFailureClass): string[] {
  switch (cls) {
    case 'harness':
      return [
        `CI failure class: HARNESS. The test suite NEVER RAN — the log shows no`,
        `tests executed (a collection/import error, or the test environment failed`,
        `to construct). This is a TOOLCHAIN failure, not a test failure.`,
        `- Fix the toolchain: bump the runtime (e.g. Node), swap or pin the broken`,
        `  dependency, or change the test environment — whatever made the suite fail`,
        `  to boot.`,
        `- Do NOT edit, add, or delete any test file or test body. The tests are not`,
        `  the problem, and every retry that rewrites them fails identically.`,
      ];
    case 'assertion':
      return [
        `CI failure class: ASSERTION. Tests ran and one or more FAILED on a real`,
        `assertion. Fix the code under test, or fix the test if it encodes the wrong`,
        `expectation. Address each named failing test.`,
      ];
    case 'infra':
      return [
        `CI failure class: INFRASTRUCTURE. The runner ran out of memory, was killed,`,
        `cancelled, or timed out at the job level — the environment failed, not the`,
        `code. Do NOT rewrite code or tests to chase this. If it does not reproduce,`,
        `the correct action is to let CI re-run; only change code if you can show it`,
        `is a genuine resource problem the code introduced.`,
      ];
    case 'static':
      return [
        `CI failure class: STATIC. This is a lint / typecheck failure only — no`,
        `tests are involved. Fix exactly the reported lines. Do NOT touch test files`,
        `or runtime behaviour.`,
      ];
    default:
      return [];
  }
}
