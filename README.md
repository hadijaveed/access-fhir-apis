# ACCESS Model — Mock FHIR Server, Test Suite & Interactive API Explorer

## What is this?

The **CMS ACCESS Model** (Advancing All-Payer Health Equity Approaches and Development of
Sustained Accountable Care Structures) is a new CMS payment model launching **July 2026**.
It pays healthcare organizations ("participants") to manage patients with chronic conditions
across **4 clinical tracks**. The entire lifecycle — screening patients, enrolling them,
reporting clinical outcomes, and exiting — happens through a **FHIR R4 API** that CMS will
operate.

**The problem:** The real CMS API doesn't exist yet. But the [FHIR Implementation Guide](https://github.com/dsacms/cmmi-access-model) (IG) is published (v0.9.1), defining every resource profile, operation, code system, and value set. We need to build against it *now* so our platform is ready on day one.

**This project** gives you three things:

1. **An interactive API Explorer** (`public/index.html`) — a browser-based tool where you can walk through every patient lifecycle step, send real FHIR payloads, and read plain-English explanations of every result. No server required — it runs entirely in-browser on GitHub Pages, or auto-connects to the mock server when available.
2. **A mock ACCESS API server** (`scripts/mock-access-server.js`) — an Express server implementing all 5 custom FHIR operations with realistic business logic, async 202 → poll → 200 patterns, and educational console logging.
3. **An E2E test suite** (`scripts/test_access_e2e.js`) — 68 tests covering every operation, every result code, and every clinical track.

Plus an **IG resource loader** (`scripts/load_ig_resources.js`) that loads all 56 conformance resources into a local HAPI FHIR server for validation testing.

```
                          ┌──────────────────────────────────────┐
                          │   API Explorer (public/index.html)   │
                          │                                      │
                          │  Simulated Mode:                     │
                          │    All logic runs in-browser.         │
                          │    Works on GitHub Pages, no server.  │
                          │                                      │
                          │  Live Mode (auto-detected):           │
                          │    Connects to Mock Server on :3001   │
                          │    for real HTTP request/response.    │
                          └────────────────┬─────────────────────┘
                                           │ (auto-detects)
┌─────────────────────────────┐     ┌──────┴─────────────────────────────┐
│  HAPI FHIR R4 Server        │     │  Mock ACCESS API Server            │
│  localhost:8080/fhir         │     │  localhost:3001/fhir               │
│                              │     │                                    │
│  What it does:               │     │  What it does:                     │
│  - Stores FHIR resources     │     │  - Simulates all 5 CMS operations  │
│  - Validates against profiles│     │  - In-memory patient alignment     │
│  - Hosts IG conformance      │     │  - Clinical data reporting         │
│    resources (CodeSystems,   │     │  - Outcome target evaluation       │
│    ValueSets, Profiles)      │     │  - Async 202 → poll → 200 pattern │
│                              │     │  - Serves API Explorer UI          │
└──────────────┬───────────────┘     └──────────────┬─────────────────────┘
               │                                    │
               └────────────┬───────────────────────┘
                            │
                   test_access_e2e.js
                   (runs against BOTH)
```

---

## Quick Start

### The fastest way to explore the API

Open `public/index.html` in any browser. That's it — no install, no server, no Docker. Everything runs client-side. You can also view it on GitHub Pages if the repo is published there.

You'll land on an interactive walkthrough of the 5-step patient lifecycle. Pick a clinical track, choose a scenario, read what it does, edit the FHIR payload if you want, hit "Send Request", and see the result with a plain-English explanation of what happened and what to do next.

### Running with the mock server (for live HTTP)

```bash
# 1. Clone and install
git clone <this-repo>
cd access-model-testing
npm install

# 2. Start the mock server
npm run start:mock
# → Mock running at http://localhost:3001/fhir
# → API Explorer at http://localhost:3001/

# 3. Open http://localhost:3001 in your browser
#    The explorer auto-detects the server and switches to "Live" mode.
#    Now requests go over real HTTP instead of in-browser simulation.

# 4. Run the test suite
npm run test
# → 68+ tests pass: all 5 operations, all result codes, all 4 tracks
```

### Adding HAPI FHIR (for validation and CRUD testing)

```bash
# 5. Start HAPI FHIR (needs Docker)
docker compose up -d
# → HAPI running at http://localhost:8080/fhir

# 6. Load IG resources
npm run load
# → 56 conformance resources loaded (CodeSystems, ValueSets, Profiles, etc.)

# 7. Run the full test suite (HAPI + Mock)
npm run test
# → ~156 assertions: CRUD, conformance, validation, all 5 operations
```

The test suite auto-detects which servers are online and skips tests for offline servers.

---

## The API Explorer — What to Expect

The API Explorer is a single HTML file (`public/index.html`) that provides an interactive, educational walkthrough of the ACCESS Model API. Here's what you'll find when you open it:

### Layout

The screen has three main areas:

- **Sidebar (left)** — the 5 lifecycle steps (Screen, Enroll, Report, Poll, Exit), a track selector (eCKM / CKM / MSK / BH), and a live count of alignments, submissions, and data reports in the current mock state.
- **Main panel (center)** — the currently selected step, with its operation name, HTTP method and endpoint, explanation, scenario selector, editable request payload, send button, and response viewer.
- **State inspector (bottom, collapsible)** — a JSON view of all in-memory state (alignments, submissions, data reports). Use it to see what's accumulated as you walk through the lifecycle.

### What each step panel contains

1. **"What This Does"** — a plain-English explanation of the operation, what CMS checks, and why. Expandable result codes table shows every possible outcome.
2. **Scenario selector** — a dropdown of pre-built scenarios (e.g., "Eligible eCKM Patient", "ESRD Exclusion", "Missing Measures") with a one-line hint explaining what each scenario demonstrates.
3. **Request payload editor** — a fully editable `<textarea>` pre-filled with valid FHIR JSON. Change any field — remove the MBI, swap the ICD-10 code, modify observation values — and see how the system responds.
4. **Field guide** — collapsible section explaining key FHIR fields (what an MBI is, what track codes look like, what LOINCs are required).
5. **Response viewer** — after sending a request, you see:
   - An animated pipeline: `202 Accepted → Polling... → 200 Complete`
   - The response JSON with syntax highlighting
   - A color-coded result explanation box with an icon, title, body, and "Next step" guidance

### Two modes of operation

The explorer works identically in both modes — same UI, same scenarios, same explanations. The only visible difference is a small badge in the header:

| | Simulated Mode | Live Mode |
|---|---|---|
| **When** | No server running (default) | Mock server detected on :3001 |
| **Badge** | Yellow "Simulated" | Green "Live Server" |
| **Where logic runs** | In-browser `MockEngine` class | Express server via real HTTP |
| **Async pattern** | Simulated with `setTimeout` | Real HTTP 202 → poll → 200 |
| **State persistence** | Resets on page refresh | Persists until server restart or manual reset |
| **State inspector** | Reads `MockEngine.getState()` | Fetches `GET /fhir/$mock-state` |

**Mode detection** happens on page load: the explorer pings `http://localhost:3001/fhir/metadata`. If it responds, live mode activates. If it doesn't (GitHub Pages, `file://`, no server), simulated mode kicks in silently.

### Scenarios (~24 pre-built)

Each step has multiple scenarios covering happy paths and error cases:

- **Screen ($check-eligibility)**: 6 scenarios — eligible patient, no MBI, ESRD exclusion, control group, wrong diagnosis, no condition
- **Enroll ($align)**: 5 scenarios — standard enrollment, already aligned, no MBI, ESRD, wrong diagnosis
- **Report ($report-data)**: 4 scenarios — baseline report, non-aligned patient, missing measures, baseline overdue
- **Poll ($submission-status)**: 2 scenarios — completed submission, invalid ID
- **Exit ($unalign)**: 4 scenarios — geographic relocation, clinical exclusion, not aligned, loss of contact

Scenarios adapt to the selected track. Switching from eCKM to BH changes the patient data, ICD-10 codes, and clinical measures to match that track's requirements.

### Track Reference

Click "Track Reference" in the header to see a detailed panel for the currently selected track: valid ICD-10 prefixes, required LOINC codes per report type (baseline / quarterly / end-of-period), OAP outcome targets, and clinical exclusion codes.

---

## The Mock Server — What to Expect

The mock server (`scripts/mock-access-server.js`) is a standalone Express app that implements all 5 ACCESS Model FHIR operations. It serves two purposes:

1. **Direct API testing** — use curl, Postman, or any HTTP client to send FHIR payloads and get responses. Every operation returns async 202 with a pollable submission ID.
2. **Backend for the API Explorer** — when the explorer detects the server running, it routes all requests through it for real HTTP interactions.

### What it does

- Implements the 5 custom FHIR operations (`$check-eligibility`, `$align`, `$report-data`, `$unalign`, `$submission-status`)
- Manages in-memory state across 4 `Map` objects (alignments, submissions, data reports, patient-ID-to-MBI mappings)
- Enforces real business rules: 90-day lock-in periods, 60-day baseline windows, track-specific ICD-10 validation, LOINC measure requirements, OAP target evaluation
- Uses the async pattern: every operation returns HTTP 202 + Content-Location header for polling
- Provides debug endpoints: `GET /fhir/$mock-state` (inspect state) and `POST /fhir/$mock-reset` (clear everything)
- Logs every decision to the console with color-coded output — great for learning what the server is checking at each step
- Serves the API Explorer from `/` when running locally

### Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `FHIR_BASE` | `http://localhost:8080/fhir` | HAPI FHIR server URL (used by tests) |
| `MOCK_BASE` | `http://localhost:3001/fhir` | Mock ACCESS server URL (used by tests) |
| `MOCK_PORT` | `3001` | Port for mock server |
| `LOCK_IN_DAYS` | `90` | Days before a patient can switch participants |
| `BASELINE_WINDOW_DAYS` | `60` | Days after alignment to submit baseline report |
| `ASYNC_DELAY_MS` | `500` | Simulated async processing delay (ms) |

---

## The Test Suite — What to Expect

The test suite (`scripts/test_access_e2e.js`) is a zero-dependency test runner that exercises every operation, every result code, and every clinical track against the mock server. When HAPI is also online, it adds CRUD, conformance, and validation tests.

### Mock-only tests (68 assertions)

| Section | Scenarios | What's Verified |
|---|---|---|
| **$check-eligibility** (8 codes) | Eligible patient, no MBI, ESRD exclusion, control group, already-aligned, wrong diagnosis, no diagnosis, switch opportunity | Every result code reachable with the right input |
| **$align** (7 codes) | Successful alignment, double-align, control group, no MBI, wrong diagnosis, ESRD, switch with lock-in | Lock-in period enforcement, switch consent flow |
| **$report-data** (12 scenarios) | MSK/BH/eCKM/CKM baselines, quarterly, end-of-period, KOOS JR alternative, non-aligned rejection, missing-measures, outside-window | Track-specific LOINC validation, reporting windows, OAP target evaluation |
| **$submission-status** | Immediate poll (202), delayed poll (200), unknown ID (404) | Async pattern works end-to-end |
| **$unalign** (3 codes) | Geographic relocation, non-aligned patient, clinical exclusion (ESRD) | Alignment status correctly updated |

### HAPI tests (additional ~88 assertions when Docker is running)

| Section | What's Tested | Count |
|---|---|---|
| Health Check | `GET /metadata` returns FHIR 4.0.1 | 2 |
| CRUD | PUT/GET/Search for Patient, Org, Practitioner, Condition | ~20 |
| Conformance | All 56 IG resources loaded (CodeSystems, ValueSets, Profiles, etc.) | ~35 |
| Validation | `$validate` on all resource types | 7 |
| Cleanup | DELETE all test resources | ~8 |

Run tests with:

```bash
npm run test          # mock-only (or both, if HAPI is up)
npm run test:full     # starts HAPI + loads IG + runs all tests
```

---

## The ACCESS Model Lifecycle

When the real CMS API goes live, a participant organization will move each patient through
this 5-step lifecycle. Every step is a FHIR operation — a special HTTP endpoint that takes
structured input and returns structured output.

```
  ┌─────────┐    ┌─────────┐    ┌────────────┐    ┌──────┐    ┌──────┐
  │ SCREEN  │───>│ ENROLL  │───>│   REPORT   │───>│ POLL │───>│ EXIT │
  │         │    │         │    │            │    │      │    │      │
  │ $check- │    │ $align  │    │ $report-   │    │$sub- │    │$un-  │
  │ elig.   │    │         │    │  data      │    │ mission│   │align │
  └─────────┘    └─────────┘    └────────────┘    │-status│   └──────┘
                                                   └──────┘
```

### Step 1: Screen (`POST /fhir/Patient/$check-eligibility`)

**Purpose:** "Is this Medicare beneficiary eligible for ACCESS in this track?"

Before enrolling a patient, you ask CMS whether they qualify. CMS checks:
- Do they have a Medicare Beneficiary Identifier (MBI)?
- Are they excluded (e.g., End-Stage Renal Disease)?
- Are they in the randomized control group?
- Are they already enrolled with a different participant?
- Does their diagnosis (ICD-10 code) match the requested track?

**What you send** — a FHIR `Parameters` resource containing:

```json
{
  "resourceType": "Parameters",
  "parameter": [
    {
      "name": "participantID",
      "valueIdentifier": { "value": "ACCESS1234" }
    },
    {
      "name": "payerID",
      "valueIdentifier": { "value": "12345" }
    },
    {
      "name": "patient",
      "resource": {
        "resourceType": "Patient",
        "identifier": [{
          "system": "http://terminology.hl7.org/NamingSystem/cmsMBI",
          "value": "1EG4TE5MK73"
        }],
        "name": [{ "family": "Doe", "given": ["John"] }],
        "gender": "male",
        "birthDate": "1950-01-01"
      }
    },
    {
      "name": "track",
      "valueCodeableConcept": {
        "coding": [{
          "system": ".../ACCESSTrackCS",
          "code": "eCKM"
        }]
      }
    },
    {
      "name": "condition",
      "resource": {
        "resourceType": "Condition",
        "code": {
          "coding": [{
            "system": "http://hl7.org/fhir/sid/icd-10-cm",
            "code": "I10",
            "display": "Essential hypertension"
          }]
        }
      }
    }
  ]
}
```

**What you get back** — HTTP 202 (Accepted) + a `Content-Location` header pointing to
the submission-status endpoint. When you poll it, you get one of **8 possible result codes**:

| Result Code | Meaning | When it happens |
|---|---|---|
| `eligible` | Patient qualifies | All checks pass |
| `eligible-pending-diagnosis` | Might qualify, needs diagnosis | No condition resource was submitted |
| `eligible-switch-participants` | Already enrolled elsewhere, can switch | Patient is aligned but switch is possible |
| `not-eligible-not-medicare` | No Medicare ID | Patient has no MBI identifier |
| `not-eligible-services` | Clinical exclusion | ESRD (N18.6), dialysis (Z99.2), or transplant (Z94.0) |
| `not-eligible-control-group` | Randomized out | SHA-256 hash of MBI+track places them in control arm |
| `not-eligible-already-aligned` | Enrolled with someone else | Different participant already has this patient |
| `not-eligible-diagnoses` | Wrong diagnosis for track | ICD-10 code doesn't match the requested track |

**How the mock handles it** (`processCheckEligibility` in mock-access-server.js):

The mock runs the checks in order. Each check either returns a result or falls through:
1. Extract the MBI from `Patient.identifier` where `system` = the CMS MBI namespace
2. Check for exclusion ICD-10 codes (N18.6, Z99.2, Z94.0) in submitted conditions
3. Hash `MBI:track` with SHA-256 — if `hash[0] % 5 === 0`, patient is in control group
4. Look up existing alignments in the in-memory `Map`
5. Validate ICD-10 prefixes against allowed codes per track
6. If no conditions submitted, return pending
7. If already aligned to same participant, offer switch
8. Otherwise, eligible

### Step 2: Enroll (`POST /fhir/Patient/$align`)

**Purpose:** "Formally enroll this patient in my ACCESS program for this track."

Same payload structure as eligibility, plus:
- `isProviderReferral` (boolean) — was this a provider referral?
- `switchConsentAttestation` (boolean, optional) — patient consents to switch participants

**What you get back** — one of **7 result codes**:

| Result Code | Meaning |
|---|---|
| `aligned` | Successfully enrolled |
| `aligned-switch-approved` | Switched from another participant (lock-in expired + consent given) |
| `not-aligned-already-aligned` | Already enrolled (same participant, or within 90-day lock-in) |
| `not-aligned-not-medicare` | No MBI |
| `not-aligned-control-group` | In control group |
| `not-aligned-services` | Clinical exclusion |
| `not-aligned-diagnoses` | ICD-10 mismatch |

**Key business rules the mock enforces:**

- **90-day lock-in:** Once aligned, a patient cannot switch to a different participant
  for 90 days. The mock stores `alignedAt` timestamps and computes elapsed days.
- **Switch consent:** After lock-in expires, switching requires `switchConsentAttestation: true`.
- **Alignment storage:** The mock stores alignments in `Map<"mbi:track" → { participantID, alignedAt, status }>`.
  This is the central registry that all other operations reference.

### Step 3: Report Clinical Data (`POST /fhir/$report-data`)

**Purpose:** "Here are the clinical measurements for this enrolled patient."

This is the most complex operation. It doesn't exist in the IG yet (v0.9.1 says "Coming
in Future Release"), so our mock is built from the RFA, CMS technical FAQs, the
[Da Vinci DEQM](http://hl7.org/fhir/us/davinci-deqm/) framework, and the
[PCO IG](http://hl7.org/fhir/us/pco/) that CMS references.

**What you send** — a `Parameters` resource containing a `MeasureReport` plus the
actual clinical `Observation`/`QuestionnaireResponse` resources:

```json
{
  "resourceType": "Parameters",
  "parameter": [
    {
      "name": "measureReport",
      "resource": {
        "resourceType": "MeasureReport",
        "status": "complete",
        "type": "data-exchange",
        "measure": "https://cms.gov/fhir/Measure/access-msk-proms",
        "subject": { "reference": "Patient/access-test-p03" },
        "date": "2026-08-15",
        "period": { "start": "2026-07-01", "end": "2026-08-15" },
        "reporter": { "reference": "Organization/ACCESS1234" }
      }
    },
    {
      "name": "resource",
      "resource": {
        "resourceType": "Observation",
        "code": { "coding": [{ "system": "http://loinc.org", "code": "72514-3" }] },
        "valueInteger": 7
      }
    },
    {
      "name": "resource",
      "resource": {
        "resourceType": "Observation",
        "code": { "coding": [{ "system": "http://loinc.org", "code": "77849-8" }] },
        "valueQuantity": { "value": 38.2, "unit": "T-score" }
      }
    }
  ]
}
```

**The mock validates 4 things:**

#### 1. Is the patient aligned?

The mock extracts `Patient/{id}` from `MeasureReport.subject`, looks up the MBI via a
reverse mapping (`patientIdToMbi`), and checks the `alignments` Map.

#### 2. What type of report is this?

Based on timing relative to alignment date:

| Report Type | When | Consequence of Missing |
|---|---|---|
| **Baseline** | Within 60 days of alignment | Miss it = auto-unalign |
| **Quarterly** | 70-110 days after prior report | Trajectory tracking |
| **End-of-Period** | After day 365 (or day 185 for early success in BH/MSK) | Final OAP determination |

#### 3. Are the required clinical measures present?

Each track requires specific LOINC-coded observations. The mock checks submitted
`Observation.code.coding[].code` against the required set:

**eCKM Track** (Early Cardio-Kidney-Metabolic) — clinical biomarkers:
| Measure | LOINC | What it is |
|---|---|---|
| Blood Pressure Panel | `85354-9` | Systolic + Diastolic BP components |
| LDL Cholesterol | `13457-7` | "Bad" cholesterol level |
| Total Cholesterol | `2093-3` | Combined cholesterol |
| Triglycerides | `2571-8` | Blood fat level |
| BMI | `39156-5` | Body mass index |
| Waist Circumference | `56086-2` | Abdominal obesity indicator |
| Fasting Glucose | `1558-6` | Blood sugar (fasting) |
| HbA1c | `4548-4` | 3-month average blood sugar |

**CKM Track** (Cardio-Kidney-Metabolic) — kidney-focused:
| Measure | LOINC | What it is |
|---|---|---|
| HbA1c | `4548-4` | 3-month average blood sugar |
| eGFR | `48642-3` | Kidney filtration rate |
| Blood Pressure Panel | `85354-9` | Systolic + Diastolic |
| UACR | `9318-7` | Urine albumin-to-creatinine (kidney damage marker) |

**MSK Track** (Musculoskeletal) — patient-reported outcome measures (PROMs):
| Measure | LOINC | What it is |
|---|---|---|
| Pain NRS (0-10) | `72514-3` | "Rate your pain" scale |
| PROMIS Physical Function | `77849-8` | T-score for physical ability |
| PROMIS Pain Interference | `62193-8` | T-score for how pain affects life |
| PGIC (end-of-period only) | `77865-4` | Patient Global Impression of Change (1-7) |

MSK also accepts **site-specific alternatives** instead of the generic PROMIS scores:
- `82324-5` KOOS JR (knee) / `82323-7` HOOS JR (hip)
- `71934-4` ODI (lower back) / `72100-1` NDI (neck)
- `71933-6` QuickDASH (shoulder/arm/hand)

**BH Track** (Behavioral Health) — depression/anxiety PROMs:
| Measure | LOINC | What it is |
|---|---|---|
| PHQ-9 Total Score | `44261-6` | Depression severity (0-27) |
| GAD-7 Total Score | `70274-6` | Anxiety severity (0-21) |
| PGIC (end-of-period only) | `77865-4` | Patient impression of change |

#### 4. OAP Target Evaluation (at end-of-period)

When an end-of-period report is submitted, the mock compares it against the stored baseline
to determine if the patient met **Outcome Assessment Period (OAP) targets**. CMS withholds
50% of OAP payments — participants earn them back if >=50% of aligned patients meet targets.

| Track | Measure | Target |
|---|---|---|
| eCKM | Systolic BP | >=10 mmHg reduction OR final <130 |
| CKM | HbA1c | Any improvement OR <7.0% |
| MSK | Pain NRS | No more than 2-point increase from baseline |
| MSK | PROMIS PF/PI | >=2 T-score point improvement |
| MSK | KOOS JR/HOOS JR | >=10 point improvement |
| MSK | ODI/NDI | >=8 point improvement |
| BH | PHQ-9 | >=5 point reduction OR final <5 (remission) |
| BH | GAD-7 | >=4 point reduction OR final <5 |

**Result codes:**
- `accepted` — report stored successfully
- `rejected-not-aligned` — patient isn't enrolled
- `rejected-missing-measures` — required LOINCs not present
- `rejected-outside-window` — timing is wrong (e.g., baseline overdue at day 65)

### Step 4: Poll (`GET /fhir/Patient/$submission-status?submissionID=xxx`)

**Purpose:** "Did my submission finish processing?"

All ACCESS operations are **asynchronous**. When you POST to any operation, you get
HTTP 202 (Accepted) — not the actual result. The response includes a `Content-Location`
header with a URL to poll.

```
POST /fhir/Patient/$align  →  HTTP 202
                                Content-Location: /fhir/Patient/$submission-status?submissionID=sub-1-...
                                Body: { "diagnostics": "...submissionID=sub-1-..." }

GET  /fhir/Patient/$submission-status?submissionID=sub-1-...
  → HTTP 202 (still processing)    ...wait...
  → HTTP 200 (done!) + result Parameters
```

The mock simulates this with a configurable delay (`ASYNC_DELAY_MS`, default 500ms).
After the delay, the submission transitions from "pending" to "complete".

### Step 5: Exit (`POST /fhir/Patient/$unalign`)

**Purpose:** "Remove this patient from my ACCESS program."

**Reasons a patient gets unaligned:**
- `geographic-relocated` — patient moved away
- `loss-of-contact` — can't reach the patient
- `no-longer-clinically-eligible` — new exclusion (e.g., developed ESRD)
- `patient-initiated` — patient asked to leave

**Result codes:**
- `unaligned` — successfully removed
- `patient-not-aligned` — patient wasn't enrolled
- `unaligned-clinical-exclusion` — removed due to new exclusion condition

---

## The 4 Clinical Tracks

Each track targets a different chronic condition population with different ICD-10 codes:

| Track | Full Name | Target Population | Example ICD-10 Codes |
|---|---|---|---|
| **eCKM** | Early Cardio-Kidney-Metabolic | Early-stage heart/kidney/metabolic disease | I10 (hypertension), E11 (diabetes), E78 (high cholesterol) |
| **CKM** | Cardio-Kidney-Metabolic | Advanced kidney disease with comorbidities | N18 (CKD), E11 (diabetes), I10 (hypertension) |
| **MSK** | Musculoskeletal | Chronic pain conditions | M17 (knee OA), M54 (back pain), M75 (shoulder) |
| **BH** | Behavioral Health | Depression and anxiety | F32/F33 (depression), F41 (anxiety), F31 (bipolar) |

The mock validates ICD-10 codes against track-specific prefix lists. For example, submitting
`F32.9` (depression) for the `eCKM` track will be rejected with `not-eligible-diagnoses`.

---

## How a Full Patient Journey Looks

Here's what happens end-to-end for an MSK patient (knee osteoarthritis):

```
Day 0: Screen
  POST /fhir/Patient/$check-eligibility
    → Patient: Robert Johnson, MBI: 3GH7IJ8KL90
    → Track: MSK
    → Condition: M17.11 (knee OA)
    → Result: "eligible"

Day 0: Enroll
  POST /fhir/Patient/$align
    → Same patient + isProviderReferral: true
    → Result: "aligned"
    → Server stores: alignments["3GH7IJ8KL90:MSK"] = {
        participantID: "ACCESS1234", alignedAt: "2026-07-01", status: "aligned"
      }

Day 30: Baseline Report
  POST /fhir/$report-data
    → MeasureReport pointing to Patient/access-test-p03, measure: access-msk-proms
    → 3 Observations: Pain NRS=7, PROMIS PF T=38.2, PROMIS PI T=62.1
    → Checks: patient aligned? Yes. Within 60-day window? Yes. Required LOINCs present? Yes.
    → Result: "accepted" (baseline stored)

Day 120: Quarterly Report
  POST /fhir/$report-data
    → 3 Observations: Pain NRS=5, PROMIS PF T=42.0, PROMIS PI T=56.0
    → Checks: 90 days since baseline, within 70-110 day quarterly window? Yes.
    → Result: "accepted" (quarterly stored, trajectory improving)

Day 410: End-of-Period Report
  POST /fhir/$report-data
    → 4 Observations: Pain NRS=4, PROMIS PF T=46.0, PROMIS PI T=50.0, PGIC=2
    → Checks: 380 days since alignment >= 365? → end-of-period
    → OAP evaluation:
        Pain NRS: baseline 7 → current 4 (increase <= 2? YES → MET)
        PROMIS PF: baseline 38.2 → current 46.0 (improvement >= 2? YES → MET)
    → Result: "accepted" + "OAP: 2/2 targets met. OAT threshold PASSED."

Day 425: Exit
  POST /fhir/Patient/$unalign
    → Reason: "geographic-relocated"
    → Result: "unaligned"
```

You can walk through this exact journey in the API Explorer — the scenarios build on each other naturally.

---

## File Structure

```
access-model-testing/
├── README.md                        # This file — start here
├── package.json                     # Scripts: start:mock, load, test, test:full
├── docker-compose.yml               # One-command HAPI FHIR startup
├── .gitignore
│
├── public/
│   └── index.html                   # API Explorer — interactive single-page app
│                                    #   Works standalone (GitHub Pages) or with mock server
│                                    #   Simulated mode: all logic runs in-browser
│                                    #   Live mode: auto-connects to localhost:3001
│
├── ig/                              # CMS ACCESS Model FHIR IG (v0.9.1)
│   │                                # Source: github.com/dsacms/cmmi-access-model
│   ├── CodeSystem-ACCESSTrackCS.json          # 4 tracks: eCKM, CKM, MSK, BH
│   ├── CodeSystem-ACCESSEligibilityResultCS.json  # 8 eligibility result codes
│   ├── CodeSystem-ACCESSAlignmentResultCS.json    # 7 alignment result codes
│   ├── CodeSystem-ACCESSUnalignment*.json         # Unalignment reasons + results
│   ├── ValueSet-ACCESS*.json                      # Diagnosis value sets per track
│   ├── StructureDefinition-access-*.json          # FHIR profiles for all operations
│   ├── OperationDefinition-*.json                 # $check-eligibility, $align, etc.
│   ├── CapabilityStatement-*.json                 # Server capability declarations
│   ├── Patient-*.json                             # Example patients
│   ├── Condition-*.json                           # Example conditions (per track)
│   ├── Parameters-*.json                          # Example request/response payloads
│   └── ... (56 resources total)
│
├── scripts/
│   ├── mock-access-server.js        # Express server — the mock ACCESS API
│   │   ├── In-memory state (4 Maps)
│   │   ├── $check-eligibility logic (8 result codes)
│   │   ├── $align logic (7 result codes, lock-in, switch)
│   │   ├── $report-data logic (4 tracks, windows, OAP targets)
│   │   ├── $unalign logic (3 result codes)
│   │   ├── $submission-status (async 202→200)
│   │   ├── Static file serving (public/)
│   │   ├── CORS headers
│   │   └── Debug endpoints ($mock-state, $mock-reset)
│   │
│   ├── test_access_e2e.js           # E2E test suite (68+ assertions)
│   │   ├── HAPI tests (CRUD, conformance, validation)
│   │   ├── $check-eligibility tests (all 8 codes)
│   │   ├── $align tests (all 7 codes + lock-in)
│   │   ├── $report-data tests (MSK/BH/eCKM/CKM + rejections)
│   │   ├── $submission-status tests (202→200, 404)
│   │   └── $unalign tests (all 3 codes)
│   │
│   └── load_ig_resources.js         # Loads ig/ resources into HAPI
│
└── payloads/                        # Standalone example payloads (curl-friendly)
    ├── check-eligibility-bh.json
    ├── align-ckm.json
    ├── align-eckm-switch.json
    ├── unalign-geographic.json
    └── unalign-clinical-esrd.json
```

---

## Methodology — How This Was Built

This project was developed through a systematic, specification-driven approach. Here's how each piece was created and why:

### 1. Start from the published IG

The [CMS ACCESS Model FHIR IG](https://github.com/dsacms/cmmi-access-model) (v0.9.1) is the single source of truth. We downloaded all 56 conformance resources — CodeSystems, ValueSets, StructureDefinitions, OperationDefinitions, CapabilityStatements, and example resources — into the `ig/` directory. These define:

- The 4 clinical tracks and their codes (`ACCESSTrackCS`)
- All result codes for each operation (`ACCESSEligibilityResultCS`, `ACCESSAlignmentResultCS`, etc.)
- ICD-10 value sets per track (`ACCESSeCKMDiagnosisVS`, etc.)
- FHIR profiles for operation inputs and outputs
- Example payloads showing correct structure

Every constant, code, and validation rule in the mock server traces back to these IG resources.

### 2. Build the mock server from IG + RFA

The mock server (`mock-access-server.js`) implements each operation by walking the IG's OperationDefinitions and result CodeSystems:

- **`$check-eligibility`** — the 8 result codes in `ACCESSEligibilityResultCS` directly map to 8 `if` checks in the handler. We ordered them by CMS's documented precedence (MBI check first, then exclusions, then control group, etc.).
- **`$align`** — same pattern with 7 result codes from `ACCESSAlignmentResultCS`, plus the 90-day lock-in rule described in the RFA.
- **`$report-data`** — this operation isn't fully specified in the IG yet (v0.9.1 says "Coming in Future Release"), so we built it from three sources: the RFA's description of baseline/quarterly/end-of-period reporting, the [Da Vinci DEQM](http://hl7.org/fhir/us/davinci-deqm/) framework for MeasureReport-based data exchange, and the [PCO IG](http://hl7.org/fhir/us/pco/) for patient-centered outcome measurement. LOINC code requirements per track come from the RFA's clinical measure specifications.
- **`$unalign`** — 3 result codes from `ACCESSUnalignmentResultCS`, with reason codes from `ACCESSUnalignmentReasonCS`.
- **Async pattern** — the IG specifies that all operations use the FHIR Async pattern (HTTP 202 + Content-Location polling). The mock simulates this with configurable delay.

The control group randomization uses a deterministic SHA-256 hash (`hash[0] % 5 === 0` for 20% assignment), providing reproducible results for testing while simulating CMS's randomization process.

### 3. Write tests for every path

The test suite was built to exercise **every result code in every CodeSystem**. For each operation, we constructed payloads that trigger each possible outcome:

- Valid patient data for happy paths
- Missing MBI for "not-medicare" codes
- ESRD condition (N18.6) for exclusion codes
- Pre-computed MBIs that hash into the control group
- Wrong ICD-10 codes for diagnosis mismatch
- Timing-based payloads for reporting window validation

Each test follows the same pattern: reset state, set up prerequisites (align a patient if testing report-data), send the request, poll for the result, assert the result code. This ensures every code path is reachable and the business logic matches the IG specification.

### 4. Build the API Explorer

The API Explorer was designed to make the API accessible without reading documentation or using curl. Key design decisions:

**Single-file architecture:** Everything is in one `index.html` — HTML, CSS, and JavaScript. No build step, no dependencies, no framework. This means it can be served from GitHub Pages, opened as a local file, or served by the mock server with zero configuration.

**Dual-mode operation:** The explorer includes a `MockEngine` class that ports the server's business logic into browser JavaScript. This means every scenario works without any server. When the mock server is running, the explorer auto-detects it and routes requests through real HTTP instead. The same UI, same scenarios, and same explanations work in both modes.

**Browser SHA-256:** The server uses Node.js's `crypto.createHash("sha256")` for control group assignment. The browser port uses the Web Crypto API (`crypto.subtle.digest("SHA-256", ...)`), which is async. For the control group scenario, we use a pre-computed MBI (`CTRL0000006`) that is verified to hash into the control group, avoiding async complexity in scenario setup.

**Educational focus:** Every result code has a plain-English explanation with three parts: what happened, why, and what to do next. The goal is to make FHIR accessible to developers who may not be FHIR experts. Field guides explain what MBIs, LOINCs, and ICD-10 codes are. The Track Reference panel shows every valid code per track.

**Scenario design:** Scenarios are generated dynamically based on the selected track. Switching from eCKM to BH changes the patient data, ICD-10 codes, and clinical observations to match that track. Each scenario has a one-line hint explaining what it demonstrates, so users can quickly find the error case they want to explore.

### 5. Integrate without breaking anything

The mock server changes were minimal — 10 lines added:
- Two imports (`fileURLToPath`, `dirname`/`join`)
- Static file serving from `public/`
- CORS headers for cross-origin browser requests
- Root redirect (`/` → `/index.html`)

These additions are purely additive. The existing 68 E2E tests all pass unchanged. The server's FHIR endpoints, business logic, state management, and console logging are completely untouched.

---

## Two Servers, Two Purposes

### HAPI FHIR Server (port 8080)

[HAPI FHIR](https://hapifhir.io/) is a real, open-source FHIR server. We use it for:

- **Storing FHIR resources** — Patient, Condition, Organization, Practitioner via standard REST (PUT/GET/DELETE)
- **Hosting IG conformance resources** — the 56 JSON files in `ig/` (from [dsacms/cmmi-access-model](https://github.com/dsacms/cmmi-access-model)): CodeSystems, ValueSets, StructureDefinitions, OperationDefinitions, CapabilityStatements, and example resources
- **Validating resources** — `POST /Patient/$validate` checks a resource against its declared profile
- **CRUD testing** — verifying our FHIR payloads are structurally correct

HAPI handles standard FHIR operations. It does **not** implement the 5 custom ACCESS
operations (`$check-eligibility`, etc.) — those return HTTP 400 on vanilla HAPI because
they need custom server-side logic.

### Mock ACCESS Server (port 3001)

Our Express server fills the gap. It implements all 5 custom operations with:

- **In-memory state** — 4 JavaScript `Map` objects track alignments, submissions, data reports, and patient-ID-to-MBI mappings
- **Realistic business logic** — control group randomization, lock-in periods, ICD-10 validation, reporting windows, OAP target evaluation
- **The async pattern** — every operation returns 202 and requires polling, just like the real CMS API will
- **Educational logging** — every decision is logged to the console with color-coded output
- **API Explorer hosting** — serves the interactive web UI from `public/`

---

## Key FHIR Concepts Used

### FHIR Operations (the `$` prefix)

Standard FHIR REST is CRUD: `GET /Patient/123`, `PUT /Patient/123`, `DELETE /Patient/123`.

**Operations** extend this with custom RPC-style endpoints prefixed with `$`. They take
`Parameters` resources as input and return `Parameters` (or `OperationOutcome`) as output.
The ACCESS API defines 5 custom operations — none of them are standard FHIR; they're
specific to the ACCESS Model.

### Parameters Resource

The universal input/output container for FHIR operations. Each `parameter` entry has a
`name` and one value field (`valueString`, `valueBoolean`, `valueIdentifier`,
`valueCodeableConcept`, or `resource` for embedded FHIR resources).

### MeasureReport

Used by `$report-data` to describe *what* is being reported. The `measure` URL identifies
which track and measure set. The `evaluatedResource` array references the actual clinical
data (Observations, QuestionnaireResponses).

### Observation

The workhorse resource for clinical data. Each lab result, vital sign, or PROM score is
an Observation with:
- `code.coding[].code` — LOINC code identifying what was measured
- `valueInteger` or `valueQuantity` — the actual value
- `effectiveDateTime` — when it was collected

### CodeSystem / ValueSet

The IG defines custom code systems (`ACCESSTrackCS`, `ACCESSEligibilityResultCS`, etc.)
with allowed values. These are loaded into HAPI so resources can be validated against them.

### OperationOutcome

FHIR's error/info response format. The mock returns these for 202 (accepted, poll later),
400 (bad request), and 404 (not found) responses.

---

## What's Real vs. What's Mocked

| Aspect | Real CMS API (July 2026) | Our Mock |
|---|---|---|
| Patient identity | CMS Medicare enrollment database | MBI in Patient.identifier |
| Control group | CMS randomization algorithm | SHA-256 hash, deterministic |
| ICD-10 validation | Claims data cross-reference | Prefix matching against IG value sets |
| Reporting windows | Calendar-based with CMS business days | Day arithmetic from alignment date |
| OAP evaluation | CMS actuarial calculation | Direct baseline-vs-current comparison |
| Async processing | Real queue (minutes/hours) | setTimeout with configurable delay |
| $report-data | Not yet in IG | Built from RFA + DEQM + PCO IG |

---

## GitHub Pages Deployment

The API Explorer is designed to work on GitHub Pages with zero configuration:

1. Push the repo to GitHub
2. Go to **Settings** > **Pages** > **Source**: Deploy from branch > set folder to `/public`
3. The explorer is live immediately — no build step, no CI, no server

All scenarios work in simulated mode. Users who clone the repo and run `npm run start:mock` get the enhanced live mode automatically.
