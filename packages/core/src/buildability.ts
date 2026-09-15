import type { RawIssue } from './github.js';

// Admissions: can a Study Room STUDENT actually finish this issue?
//
// A student is a headless Claude Code CLI in a git worktree with bash, file
// tools, git and gh. That is a lot — and it is not everything. Some issues
// cannot be finished from there no matter how capable the model is, and
// dispatching one burns a full session to arrive at "I can't", then a reviewer
// rejects the half-thing it built, then a fixer tries again. dungeonworks #47
// ("Source and license the 40-sticker starter pack") is the clean example: it
// needs real image files acquired from third-party sites, per-submission licence
// verification, and an art-style judgement. No amount of retrying fixes that.
//
// This module answers only the CAPABILITY question. Whether an issue is
// well-written is issueAudit.ts; whether it is one PR's worth is triage. An
// issue can be beautifully specified, correctly sized, and still impossible.
//
// THE COSTS ARE ASYMMETRIC, and that shapes every threshold here. Wrongly
// calling something blocked takes real work off the board and hides it behind a
// label until a human notices — the damage is silent and open-ended. Wrongly
// calling something buildable costs one session that fails honestly and loudly.
// So: only label `blocked` on evidence that is hard to misread, and prefer
// `unsure` to a guess. `unsure` leaves the issue exactly as it was.

export type BlockerKind =
  /** Needs files that must be obtained from outside the repo: art, fonts,
   *  datasets, model weights, a vendor SDK. A student can write code that USES
   *  them; it cannot go and get them. */
  | 'external-assets'
  /** Needs a GPU, a device, or physical hardware the student does not have. */
  | 'hardware'
  /** Needs a secret, an account, a paid plan, or someone to click "authorise". */
  | 'credentials'
  /** Needs a licensing, legal or attribution judgement. Getting this wrong ships
   *  a defect that a test cannot catch and a human has to answer for. */
  | 'licensing'
  /** Needs a human's preference: product direction, visual design, naming, or
   *  "decide which approach we want". A student can implement a decision; it
   *  should not invent one and present it as done. */
  | 'human-judgement'
  /** Needs a live third-party service, a deployed environment, or real user
   *  traffic that does not exist in a worktree. */
  | 'live-service'
  /** Needs someone to LOOK at the result — visual QA, "check it feels right". */
  | 'human-verification';

export interface Blocker {
  kind: BlockerKind;
  /** The exact label or phrase that triggered it, so a human can judge the call
   *  rather than trust it. Every blocker must be traceable to something the
   *  issue actually says. */
  evidence: string;
  /** What a human would have to supply to unblock it. */
  needs: string;
}

export type AdmissionVerdict =
  /** A student can finish this from a worktree. */
  | 'buildable'
  /** Something outside the student's reach is required. */
  | 'blocked'
  /** Signals conflict or are weak. Left alone — see the asymmetry note above. */
  | 'unsure';

export interface Admission {
  verdict: AdmissionVerdict;
  blockers: Blocker[];
  /** True when the verdict rests on a repo LABEL rather than prose. Label
   *  evidence is deliberate human intent and is worth acting on alone; prose is
   *  a hint. */
  fromLabel: boolean;
}

/** Label applied to an issue a student cannot finish. */
export const NEEDS_HUMAN_LABEL = 'needs-human';

// Labels the repos already use to mark capability constraints. Reading the
// board's OWN vocabulary beats inventing one: dungeonworks carries `needs-gpu`
// on 8 open issues and `type:licensing` on the sticker-pack issue, which is the
// maintainer having already answered this question by hand.
const LABEL_BLOCKERS: Array<{ label: RegExp; kind: BlockerKind; needs: string; withLabel?: RegExp }> = [
  // `needs-gpu` alone is NOT a blocker, and treating it as one was wrong.
  //
  // The distinction that matters is whether the GPU is needed to BUILD the thing
  // or merely to RUN it. dungeonworks carries the label on both, and the two are
  // opposite answers:
  //
  //   type:research  — the deliverable IS the measurement. #19 is "run the S2
  //                    benchmark and record the decision"; there is no artifact
  //                    without a GPU run. Genuinely blocked.
  //   type:feature   — the deliverable is code that happens to call a local
  //                    model. #55 is explicit that a scene "must still render
  //                    with the DM server switched off, which is the normal
  //                    state of Pat's GPU box" — the spec REQUIRES a working
  //                    deterministic fallback, so a student can write and test
  //                    the whole thing. Only the inference path waits on a human.
  //
  // Blocking those four features removed real work for no gain, which is exactly
  // the asymmetric failure this module exists to avoid. If another repo uses
  // `needs-gpu` to mean something stricter, this under-blocks and costs one
  // session that fails loudly — the cheap direction, deliberately.
  { label: /^needs-gpu$/i, withLabel: /^type:research$/i, kind: 'hardware', needs: 'a GPU run to produce the measurement this issue delivers' },
  { label: /^type:licensing$/i, kind: 'licensing', needs: 'a human to choose sources and accept their licence terms' },
  { label: /^needs-(credentials|secrets|account)$/i, kind: 'credentials', needs: 'credentials a student must never hold' },
  { label: /^needs-(human|design|decision)$/i, kind: 'human-judgement', needs: 'a decision only the owner can make' },
];

// Prose signals. Deliberately narrow: each phrase has to be one that survives
// being read out of context, because a substring match is all the evidence
// there is. "download", "buy" and "design" on their own are far too broad —
// issues say "download the config", "buy-in", "design a schema" constantly.
const TEXT_BLOCKERS: Array<{ re: RegExp; kind: BlockerKind; needs: string }> = [
  {
    re: /\b(source|acquire|obtain|purchase|buy|licen[cs]e)\b[^.\n]{0,60}\b(asset|artwork|art|sticker|sprite|texture|font|image|icon|sound|music|dataset|model weights)\b/i,
    kind: 'external-assets',
    needs: 'someone to obtain the files and accept their licence',
  },
  {
    re: /\b(CC0|CC-BY|OpenGameArt|itch\.io|Kenney|royalty[- ]free|public domain)\b/i,
    kind: 'licensing',
    needs: 'a human to verify the licence terms per source',
  },
  {
    re: /\b(API key|access token|client secret|service account|credentials?)\b[^.\n]{0,40}\b(provide|obtain|create|set up|configure)\b/i,
    kind: 'credentials',
    needs: 'a secret the owner must create and store',
  },
  {
    re: /\bneeds? (a )?(GPU|CUDA|physical device|real hardware)\b/i,
    kind: 'hardware',
    needs: 'hardware the student does not have',
  },
  {
    re: /\b(decide|choose|pick) (which|whether|between|the)\b[^.\n]{0,50}\b(we|product|brand|visual|design|direction)\b/i,
    kind: 'human-judgement',
    needs: 'a product or design decision from the owner',
  },
  {
    re: /\b(against|using) (the )?(live|production|staging) (service|API|environment|database)\b/i,
    kind: 'live-service',
    needs: 'access to an environment that does not exist in a worktree',
  },
  {
    re: /\b(visually (check|verify|confirm)|looks? right|eyeball|by eye|human review of the (design|visuals|UI))\b/i,
    kind: 'human-verification',
    needs: 'a person to look at the result',
  },
];

/** Blockers a repo LABEL asserts. Deliberate human intent, so worth acting on. */
export function labelBlockers(labels: string[]): Blocker[] {
  const out: Blocker[] = [];
  for (const name of labels) {
    for (const { label, kind, needs, withLabel } of LABEL_BLOCKERS) {
      if (!label.test(name)) continue;
      // A rule may require a SECOND label before it blocks — see `needs-gpu`,
      // which means "runs on a GPU" on a feature and "is a GPU measurement" on
      // research. One label cannot carry both answers.
      if (withLabel) {
        const partner = labels.find((l) => withLabel.test(l));
        if (!partner) continue;
        out.push({ kind, evidence: `labels \`${name}\` + \`${partner}\``, needs });
        continue;
      }
      out.push({ kind, evidence: `label \`${name}\``, needs });
    }
  }
  return out;
}

/** Blockers the issue's prose suggests. A hint, never proof on its own. */
export function textBlockers(text: string): Blocker[] {
  const out: Blocker[] = [];
  const body = text ?? '';
  for (const { re, kind, needs } of TEXT_BLOCKERS) {
    const m = re.exec(body);
    if (m) out.push({ kind, evidence: `"${m[0].trim().slice(0, 80)}"`, needs });
  }
  return out;
}

/**
 * Can a student finish this?
 *
 * A LABEL alone is enough to block: someone already made that call by hand, and
 * overriding a maintainer's explicit `needs-gpu` would be worse than useless.
 *
 * PROSE alone is not. One phrase in a long issue is weak evidence — an issue can
 * mention licensing in its background and still be a pure code change — so prose
 * needs corroboration: two independent blocker kinds, or one kind stated more
 * than once. Below that bar the verdict is `unsure`, which changes nothing.
 */
export function assessAdmission(issue: RawIssue): Admission {
  const labels = issue.labels.map((l) => l.name);
  const fromLabels = labelBlockers(labels);
  const fromText = textBlockers(`${issue.title}\n${issue.body ?? ''}`);

  if (fromLabels.length) {
    return { verdict: 'blocked', blockers: [...fromLabels, ...fromText], fromLabel: true };
  }
  const kinds = new Set(fromText.map((b) => b.kind));
  if (kinds.size >= 2 || fromText.length >= 2) {
    return { verdict: 'blocked', blockers: fromText, fromLabel: false };
  }
  if (fromText.length === 1) {
    return { verdict: 'unsure', blockers: fromText, fromLabel: false };
  }
  return { verdict: 'buildable', blockers: [], fromLabel: false };
}

/**
 * The comment left on a blocked issue.
 *
 * It stays OPEN and keeps its place on the board — the point is not to close
 * work, it is to stop a student burning sessions discovering it cannot start.
 * So the comment says what is missing and exactly how to hand it back.
 */
export function needsHumanComment(a: Admission): string {
  const lines = [
    '**Study Room cannot build this issue as written.**',
    '',
    'A student works from a git worktree with bash, file tools, git and `gh`. This',
    'issue needs something outside that reach:',
    '',
  ];
  const seen = new Set<string>();
  for (const b of a.blockers) {
    const key = `${b.kind}|${b.needs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- **${b.kind}** — ${b.needs}  \n  _evidence: ${b.evidence}_`);
  }
  lines.push(
    '',
    'The issue stays open and is not being closed or rewritten. It is simply not',
    `dispatched: the \`${NEEDS_HUMAN_LABEL}\` label keeps students off it so the board`,
    'does not spend sessions failing at it.',
    '',
    `Once the missing piece exists, remove \`${NEEDS_HUMAN_LABEL}\` and the board picks`,
    'it up on the next ingest. If this call is wrong, removing the label is also the',
    'override — nothing here re-applies it without a human asking.',
  );
  return lines.join('\n');
}
