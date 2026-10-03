// Fictional notes for the chat eval. Extends scripts/demo/seed.py so people
// and topics recur across meetings (Sam, Priya, SSO, Northwind), which is
// what makes cross-note questions worth asking. Everything here is invented.
//
// Dates are relative to the moment the eval runs (like the demo seed), so
// "yesterday" questions stay true whenever it is run.
//
// transcript: [source, text] pairs; source is "mic" (the user) or "speaker".

const DESIGN_REVIEW_USER = `agenda: onboarding v2, empty states, launch date

- 3 steps not 5, cut workspace naming
- empty state = sample note? Priya worried it looks fake
- launch 14th?? depends on QA
- me: write copy for permissions screen`;

const DESIGN_REVIEW_ENHANCED = `### Onboarding v2
- [noted] Cut from 5 steps to 3; workspace naming moves to settings
- [ai] Drop-off data shows most people leave at step 4 (calendar access), so it moves to after the first note
- [ai] Microphone permission is asked only when the first recording starts

### Empty states
- [noted] Show a sample note on first launch
- [ai] Priya is worried a sample note reads as fake; agreed to label it clearly and let people remove it in one click
- [ai] Tom will mock up a version that shows a 20-second guided recording instead

### Launch
- [noted] Target the 14th, dependent on QA
- [ai] QA needs the final build by the 9th; anything later moves launch to the 21st

### Actions
- [noted] **Me:** write the copy for the permissions screen
- [ai] **Tom:** guided-recording mock-up by Thursday
- [ai] **Priya:** confirm the QA window with the release team`;

const DESIGN_REVIEW_TRANSCRIPT = [
  [
    "mic",
    "Okay, so three things today: onboarding v2, empty states, and whether the 14th is still realistic.",
  ],
  [
    "speaker",
    "Can we start with the step count? I went through the funnel data last night.",
  ],
  [
    "speaker",
    "Most of the drop-off is at step four, the calendar access screen. People just close the window.",
  ],
  [
    "mic",
    "So we cut it to three and push calendar access to after the first note?",
  ],
  [
    "speaker",
    "Yes. And workspace naming can live in settings. Nobody names their workspace on day one.",
  ],
  ["mic", "Agreed. What about microphone permission?"],
  [
    "speaker",
    "Ask for it when they press record the first time. It makes sense in context then.",
  ],
  [
    "speaker",
    "On empty states, I'm still worried a sample note looks fake. It's somebody else's meeting.",
  ],
  [
    "mic",
    "What if we label it clearly as a sample and make it one click to remove?",
  ],
  [
    "speaker",
    "I could mock up an alternative: a twenty-second guided recording instead of a sample.",
  ],
  ["mic", "Let's see both. Tom, can you have that by Thursday?"],
  ["speaker", "Thursday works."],
  ["mic", "Last thing, launch date. Is the 14th still realistic?"],
  [
    "speaker",
    "Only if QA gets the final build by the 9th. If it slips past that, we're looking at the 21st.",
  ],
  [
    "mic",
    "Okay. I'll write the permissions copy this week. Priya, can you confirm the QA window?",
  ],
  ["speaker", "I'll check with the release team today."],
];

const VENDOR_TRANSCRIPT = [
  ["mic", "Thanks for joining, Lena. Our main question is data residency."],
  [
    "speaker",
    "Sure. Everything is hosted in Frankfurt, with failover to Dublin. Both stay inside the EU.",
  ],
  [
    "mic",
    "Good, EU-only is a hard requirement for us. What about subprocessors?",
  ],
  ["speaker", "I'll send the full list together with the DPA by Friday."],
  ["mic", "And uptime?"],
  [
    "speaker",
    "Our SLA is 99.9 percent monthly, with service credits if we miss it.",
  ],
  ["mic", "How does pricing work?"],
  [
    "speaker",
    "It's per seat. Annual billing gets fifteen percent off, and there's a minimum of twenty seats.",
  ],
  ["mic", "We'd probably start around twenty-five seats."],
  [
    "speaker",
    "That works. I can send a quote once you confirm the seat count.",
  ],
  ["mic", "I'll confirm the seat count after I talk to the team."],
];

const SAM_TRANSCRIPT = [
  ["mic", "How are things going? Anything on your mind for next quarter?"],
  [
    "speaker",
    "Honestly I'd like to do more infrastructure work. The audio pipeline especially, I'd love to own that.",
  ],
  [
    "mic",
    "That makes sense. Let's pair on the next change to it so you get to know the code.",
  ],
  ["speaker", "That would be great."],
  [
    "mic",
    "On your design doc, the problem statement is really strong. The rollout plan needs a fallback though, in case the new path breaks.",
  ],
  ["speaker", "Fair. I'll add one and send you the revised plan by Wednesday."],
  ["mic", "Great, I'll review it when it comes in."],
];

const BUDGET_TRANSCRIPT = [
  ["mic", "Okay, Q1 marketing budget. Dana, where did we land on the total?"],
  ["speaker", "The total is 150k for the quarter, same as Q4."],
  ["mic", "And how does it split?"],
  [
    "speaker",
    "Events were 60k last quarter. I want to cut that to 35k. The two conferences didn't bring in enough pipeline.",
  ],
  ["mic", "Which ones are we keeping?"],
  ["speaker", "Just the London summit in February. We drop the Berlin expo."],
  ["speaker", "If we drop Berlin we lose the booth deposit, about 4k."],
  ["mic", "That's fine, it's gone either way."],
  [
    "speaker",
    "Content stays at 30k. That covers the newsletter and the two case studies.",
  ],
  ["mic", "What about paid search?"],
  [
    "speaker",
    "I'd put 40k into paid search. Last quarter it was 25k and it was our cheapest channel per signup.",
  ],
  ["mic", "Forty seems like a big jump."],
  [
    "speaker",
    "It's the one channel where we have clean numbers. Cost per signup was about 18 pounds.",
  ],
  ["mic", "Okay, I can live with that if we review it at the end of January."],
  ["speaker", "The rest, 45k, goes to the agency retainer for the rebrand."],
  ["mic", "Is the agency contract signed?"],
  [
    "speaker",
    "Not yet. Their quote came in at 52k, so either they come down or we cut scope.",
  ],
  ["speaker", "Marco thinks we can drop the video work and get it to 45."],
  ["mic", "Let's do that. Can you ask them?"],
  [
    "speaker",
    "I'll go back to them tomorrow. But I need you to confirm the budget with finance by Friday, otherwise the agency won't hold the slot.",
  ],
];

const SMALL_TALK = [
  ["mic", "Thanks for making the time."],
  ["speaker", "Of course, let's get into it."],
];

// key, title, daysAgo, hh, mm, minutes, userNotes, enhancedNotes, transcript
// A null daysAgo means "in progress": started `minutes` ago and still going.
export const NOTES = [
  {
    key: "budget-live",
    title: "Budget review: Q1 marketing",
    daysAgo: null,
    minutes: 24,
    userNotes: "",
    enhancedNotes: "",
    transcript: BUDGET_TRANSCRIPT,
  },
  {
    key: "design-review",
    title: "Design review: onboarding v2",
    daysAgo: 0,
    hh: 11,
    mm: 0,
    minutes: 34,
    userNotes: DESIGN_REVIEW_USER,
    enhancedNotes: DESIGN_REVIEW_ENHANCED,
    transcript: DESIGN_REVIEW_TRANSCRIPT,
  },
  {
    key: "vendor-call",
    title: "Vendor call: data residency",
    daysAgo: 0,
    hh: 9,
    mm: 30,
    minutes: 32,
    userNotes:
      "- EU-only hosting a must\n- ask about subprocessors\n- pricing per seat?",
    enhancedNotes:
      "### Data residency\n- [noted] EU-only hosting is a hard requirement\n- [ai] They host in Frankfurt with failover to Dublin; both stay inside the EU\n\n### Subprocessors\n- [noted] Asked for the full subprocessor list\n- [ai] They'll send it with the DPA by Friday\n\n### Pricing\n- [noted] Per-seat pricing\n- [ai] 15% discount on annual billing; minimum of 20 seats",
    transcript: VENDOR_TRANSCRIPT,
  },
  {
    key: "product-sync",
    title: "Weekly product sync",
    daysAgo: 1,
    hh: 16,
    mm: 0,
    minutes: 41,
    userNotes:
      "- search shipped\n- calendar beta feedback\n- bugs: pill on 2nd monitor",
    enhancedNotes:
      "### Shipped\n- [noted] Full-text search is out\n- [ai] Early usage: about a third of people search in their first week\n\n### Calendar beta\n- [noted] Feedback so far\n- [ai] People like auto-titles; two asked for attendees in the export\n- [ai] **Me:** send the team a summary of the beta feedback by Monday\n\n### Bugs\n- [noted] Recording pill shows on the wrong monitor\n- [ai] Reproduces only when the main window is on an external display\n- [ai] Sam is fixing it and expects to have a fix next week",
    transcript: SMALL_TALK,
  },
  {
    key: "sam-1on1",
    title: "1:1 with Sam",
    daysAgo: 1,
    hh: 11,
    mm: 0,
    minutes: 28,
    userNotes: "- career: wants more infra work\n- feedback on design doc",
    enhancedNotes:
      "### Growth\n- [noted] Wants more infrastructure work next quarter\n- [ai] Interested in owning the audio pipeline; agreed to pair on the next change\n\n### Feedback\n- [noted] Design doc review\n- [ai] Strong on the problem statement; the rollout plan needs a fallback\n- [ai] Sam will add a fallback and send the revised plan by Wednesday\n\n### Actions\n- [ai] **Me:** review Sam's revised rollout plan when it arrives\n- [ai] **Me:** pair with Sam on the next audio pipeline change",
    transcript: SAM_TRANSCRIPT,
  },
  {
    key: "backend-interview",
    title: "Interview: backend engineer",
    daysAgo: 2,
    hh: 14,
    mm: 0,
    minutes: 55,
    userNotes:
      "- strong on concurrency\n- system design: rate limiter\n- unclear on testing",
    enhancedNotes:
      "### Technical\n- [noted] Strong on concurrency\n- [ai] Explained lock-free queues clearly and when not to use them\n\n### System design\n- [noted] Rate limiter\n- [ai] Started with a token bucket, then moved to a sliding window when asked about bursts\n\n### Concerns\n- [noted] Unclear on testing\n- [ai] Hasn't written property-based tests; open to learning\n\n### Next steps\n- [ai] No decision yet; waiting on references",
    transcript: SMALL_TALK,
  },
  {
    key: "northwind-call",
    title: "Customer call: Northwind",
    daysAgo: 3,
    hh: 10,
    mm: 0,
    minutes: 37,
    userNotes:
      "- 40 seats, rollout in Nov\n- SSO required\n- wants transcript export",
    enhancedNotes:
      "### Rollout\n- [noted] 40 seats, rolling out in November\n- [ai] Starting with the research team, then sales in December\n\n### Requirements\n- [noted] SSO is required\n- [ai] They use Okta; SAML is fine\n- [noted] Transcript export\n- [ai] Markdown is enough; they paste into their wiki\n\n### Follow-ups\n- [ai] **Me:** send the SSO setup guide and a sample Markdown export by Friday",
    transcript: SMALL_TALK,
  },
  {
    key: "q4-planning",
    title: "Q4 planning",
    daysAgo: 6,
    hh: 13,
    mm: 0,
    minutes: 88,
    userNotes: "- themes: reliability, search, sharing\n- cut: mobile app",
    enhancedNotes:
      "### Themes\n- [noted] Reliability, search, sharing\n- [ai] Reliability first: crash-free sessions at 99.5% before anything new\n- [ai] Priya owns sharing; link sharing is the first milestone, due in November\n\n### Cut\n- [noted] Mobile app\n- [ai] Revisit in Q1 once sharing has shipped",
    transcript: SMALL_TALK,
  },
  {
    key: "sso-review",
    title: "Security review: SSO rollout",
    daysAgo: 8,
    hh: 15,
    mm: 30,
    minutes: 45,
    userNotes:
      "- Okta SAML first, Azure AD later\n- Sam owns SAML integration\n- pen test before GA",
    enhancedNotes:
      "### Scope\n- [noted] Okta SAML first; Azure AD after\n- [ai] Northwind is the first customer that needs it, for their November rollout\n\n### Ownership\n- [noted] Sam owns the SAML integration\n- [ai] Target: SAML in beta by 20 October\n\n### Security\n- [noted] Pen test before GA\n- [ai] External pen test booked for the first week of November; GA waits on the report",
    transcript: SMALL_TALK,
  },
  {
    key: "designer-interview",
    title: "Interview: product designer",
    daysAgo: 9,
    hh: 11,
    mm: 0,
    minutes: 50,
    userNotes: "",
    enhancedNotes: "",
    transcript: SMALL_TALK,
  },
  {
    key: "retro",
    title: "Retro: launch week",
    daysAgo: 23,
    hh: 16,
    mm: 0,
    minutes: 47,
    userNotes:
      "- launch went ok\n- support queue spiked day 2 (import bug)\n- next time: code freeze 3 days before",
    enhancedNotes: "",
    transcript: SMALL_TALK,
  },
  {
    key: "pricing-workshop",
    title: "Pricing workshop",
    daysAgo: 31,
    hh: 10,
    mm: 30,
    minutes: 62,
    userNotes:
      "- two plans\n- annual = 2 months free\n- Priya drafts pricing page",
    enhancedNotes:
      "### Plans\n- [noted] Two plans\n- [ai] Team at £12 per seat per month; Business at £20 with SSO and admin controls\n\n### Discounts\n- [noted] Annual billing gets two months free\n\n### Next\n- [noted] Priya drafts the pricing page",
    transcript: SMALL_TALK,
  },
];

/** Materialise NOTES against `now`: ids, unix start times, timed segments. */
export function materialise(now = new Date()) {
  const base = new Date(now);
  base.setSeconds(0, 0);
  return NOTES.map((n) => {
    let start;
    if (n.daysAgo == null) {
      start = new Date(base.getTime() - n.minutes * 60_000);
    } else {
      start = new Date(base);
      start.setDate(start.getDate() - n.daysAgo);
      start.setHours(n.hh, n.mm, 0, 0);
    }
    const span = Math.floor(
      (n.minutes * 60_000) / Math.max(1, n.transcript.length),
    );
    return {
      id: `note-${n.key}`,
      key: n.key,
      title: n.title,
      startedAt: Math.floor(start.getTime() / 1000),
      environmentId: null,
      userNotes: n.userNotes,
      enhancedNotes: n.enhancedNotes,
      segments: n.transcript.map(([source, text], i) => ({
        source,
        text,
        startMs: i * span,
      })),
    };
  });
}
