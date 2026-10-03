#!/usr/bin/env python3
"""Seed a Talky data directory with fictional meetings for screenshots.

Usage: python3 scripts/demo/seed.py "<app data dir>/sessions.db"

Run it against a demo build (a different bundle identifier), never against
real data: it deletes every note, folder and tag in the target database.
Everything here is invented.
"""

import sqlite3
import sys
import time
import uuid
from datetime import datetime, timedelta

DB = sys.argv[1]
now = datetime.now().replace(second=0, microsecond=0)


def at(days_ago: int, hh: int, mm: int) -> int:
    d = (now - timedelta(days=days_ago)).replace(hour=hh, minute=mm)
    return int(d.timestamp())


FOLDERS = {
    "product": ("Product", None),
    "hiring": ("Hiring", None),
    "customers": ("Customers", None),
    "vendors": ("Vendors", None),
}
TAGS = {"follow-up": None, "decision": None}

# The note the screenshots open on: sparse typed notes, an enhanced version
# that keeps them and adds what the transcript covered, and the transcript.
HERO_USER = """agenda: onboarding v2, empty states, launch date

- 3 steps not 5, cut workspace naming
- empty state = sample note? Priya worried it looks fake
- launch 14th?? depends on QA
- me: write copy for permissions screen"""

HERO_ENHANCED = """### Onboarding v2
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
- [ai] **Priya:** confirm the QA window with the release team"""

HERO_TRANSCRIPT = [
    ("mic", "Okay, so three things today: onboarding v2, empty states, and whether the 14th is still realistic."),
    ("speaker", "Can we start with the step count? I went through the funnel data last night."),
    ("speaker", "Most of the drop-off is at step four, the calendar access screen. People just close the window."),
    ("mic", "So we cut it to three and push calendar access to after the first note?"),
    ("speaker", "Yes. And workspace naming can live in settings. Nobody names their workspace on day one."),
    ("mic", "Agreed. What about microphone permission?"),
    ("speaker", "Ask for it when they press record the first time. It makes sense in context then."),
    ("speaker", "On empty states, I'm still worried a sample note looks fake. It's somebody else's meeting."),
    ("mic", "What if we label it clearly as a sample and make it one click to remove?"),
    ("speaker", "I could mock up an alternative: a twenty-second guided recording instead of a sample."),
    ("mic", "Let's see both. Tom, can you have that by Thursday?"),
    ("speaker", "Thursday works."),
    ("mic", "Last thing, launch date. Is the 14th still realistic?"),
    ("speaker", "Only if QA gets the final build by the 9th. If it slips past that, we're looking at the 21st."),
    ("mic", "Okay. I'll write the permissions copy this week. Priya, can you confirm the QA window?"),
    ("speaker", "I'll check with the release team today."),
]

OTHERS = [
    # (folder, title, days_ago, hh, mm, minutes, user_notes, enhanced, tags)
    ("vendors", "Vendor call: data residency", 0, 9, 30, 32,
     "- EU-only hosting a must\n- ask about subprocessors\n- pricing per seat?",
     "### Data residency\n- [noted] EU-only hosting is a hard requirement\n- [ai] They host in Frankfurt with failover to Dublin; both stay inside the EU\n\n### Subprocessors\n- [noted] Asked for the full subprocessor list\n- [ai] They'll send it with the DPA by Friday\n\n### Pricing\n- [noted] Per-seat pricing\n- [ai] 15% discount on annual billing; minimum of 20 seats",
     ["follow-up"]),
    ("product", "Weekly product sync", 1, 16, 0, 41,
     "- search shipped\n- calendar beta feedback\n- bugs: pill on 2nd monitor",
     "### Shipped\n- [noted] Full-text search is out\n- [ai] Early usage: about a third of people search in their first week\n\n### Calendar beta\n- [noted] Feedback so far\n- [ai] People like auto-titles; two asked for attendees in the export\n\n### Bugs\n- [noted] Recording pill shows on the wrong monitor\n- [ai] Reproduces only when the main window is on an external display",
     []),
    (None, "1:1 with Sam", 1, 11, 0, 28,
     "- career: wants more infra work\n- feedback on design doc",
     "### Growth\n- [noted] Wants more infrastructure work next quarter\n- [ai] Interested in owning the audio pipeline; agreed to pair on the next change\n\n### Feedback\n- [noted] Design doc review\n- [ai] Strong on the problem statement; the rollout plan needs a fallback",
     []),
    ("hiring", "Interview: backend engineer", 2, 14, 0, 55,
     "- strong on concurrency\n- system design: rate limiter\n- unclear on testing",
     "### Technical\n- [noted] Strong on concurrency\n- [ai] Explained lock-free queues clearly and when not to use them\n\n### System design\n- [noted] Rate limiter\n- [ai] Started with a token bucket, then moved to a sliding window when asked about bursts\n\n### Concerns\n- [noted] Unclear on testing\n- [ai] Hasn't written property-based tests; open to learning",
     ["decision"]),
    ("customers", "Customer call: Northwind", 3, 10, 0, 37,
     "- 40 seats, rollout in Nov\n- SSO required\n- wants transcript export",
     "### Rollout\n- [noted] 40 seats, rolling out in November\n- [ai] Starting with the research team, then sales in December\n\n### Requirements\n- [noted] SSO is required\n- [ai] They use Okta; SAML is fine\n- [noted] Transcript export\n- [ai] Markdown is enough; they paste into their wiki",
     ["follow-up"]),
    ("product", "Q4 planning", 6, 13, 0, 88,
     "- themes: reliability, search, sharing\n- cut: mobile app",
     "### Themes\n- [noted] Reliability, search, sharing\n- [ai] Reliability first: crash-free sessions at 99.5% before anything new\n\n### Cut\n- [noted] Mobile app\n- [ai] Revisit in Q1 once sharing has shipped",
     ["decision"]),
    (None, "Security review: SSO rollout", 8, 15, 30, 45, "", "", []),
    ("hiring", "Interview: product designer", 9, 11, 0, 50, "", "", []),
    ("product", "Retro: launch week", 23, 16, 0, 47, "", "", []),
    ("customers", "Pricing workshop", 31, 10, 30, 62, "", "", []),
]


def main() -> None:
    con = sqlite3.connect(DB)
    c = con.cursor()
    for table in ("session_tags", "transcript_segments", "meeting_notes", "sessions", "tags", "folders"):
        c.execute(f"DELETE FROM {table}")
    created = int(time.time())

    folder_ids = {}
    for i, (key, (name, color)) in enumerate(FOLDERS.items()):
        folder_ids[key] = str(uuid.uuid4())
        c.execute("INSERT INTO folders (id, name, color, sort_order, created_at) VALUES (?,?,?,?,?)",
                  (folder_ids[key], name, color, i, created))
    tag_ids = {}
    for name, color in TAGS.items():
        tag_ids[name] = str(uuid.uuid4())
        c.execute("INSERT INTO tags (id, name, color) VALUES (?,?,?)", (tag_ids[name], name, color))

    def add(folder, title, start, minutes, user, enhanced, tags, transcript=None):
        sid = str(uuid.uuid4())
        c.execute("INSERT INTO sessions (id, title, started_at, ended_at, status, folder_id) VALUES (?,?,?,?,?,?)",
                  (sid, title, start, start + minutes * 60, "completed", folder_ids.get(folder)))
        if user or enhanced:
            c.execute("INSERT INTO meeting_notes (session_id, user_notes, enhanced_notes, created_at, updated_at) VALUES (?,?,?,?,?)",
                      (sid, user, enhanced or None, start, start))
        for name in tags:
            c.execute("INSERT INTO session_tags (session_id, tag_id) VALUES (?,?)", (sid, tag_ids[name]))
        if transcript is None:
            transcript = [("mic", "Thanks for making the time."), ("speaker", "Of course, let's get into it.")]
        span = minutes * 60_000 // max(1, len(transcript))
        for i, (source, text) in enumerate(transcript):
            s = i * span
            c.execute("INSERT INTO transcript_segments (session_id, text, source, start_ms, end_ms, created_at) VALUES (?,?,?,?,?,?)",
                      (sid, text, source, s, s + min(span, 9000), start))
        return sid

    add("product", "Design review: onboarding v2", at(0, 11, 0), 34,
        HERO_USER, HERO_ENHANCED, ["follow-up"], HERO_TRANSCRIPT)
    for folder, title, d, hh, mm, mins, user, enh, tags in OTHERS:
        add(folder, title, at(d, hh, mm), mins, user, enh, tags)
    con.commit()
    print("seeded", c.execute("SELECT count(*) FROM sessions").fetchone()[0], "notes")


if __name__ == "__main__":
    main()
