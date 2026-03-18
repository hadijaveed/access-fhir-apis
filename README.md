<p align="center">
  <strong>ACCESS FHIR Sandbox</strong><br>
  <em>Explore the CMS ACCESS Model API before it exists</em>
</p>

<p align="center">
  <a href="https://hadijaveed.github.io/access-fhir-apis/"><strong>Live Demo</strong></a>&ensp;|&ensp;
  <a href="#try-it-now">Try It Now</a>&ensp;|&ensp;
  <a href="#what-you-get">What You Get</a>&ensp;|&ensp;
  <a href="#the-access-model-lifecycle">Lifecycle</a>&ensp;|&ensp;
  <a href="#methodology">How It Was Built</a>
</p>

---

The **CMS ACCESS Model** is a new payment model launching **July 2026** that will pay healthcare organizations to manage patients with chronic conditions across 4 clinical tracks. The entire patient lifecycle — screening, enrolling, reporting clinical outcomes, and exiting — flows through a **FHIR R4 API** that CMS will operate.

The API doesn't exist yet. The [Implementation Guide](https://github.com/dsacms/cmmi-access-model) is published. **This sandbox lets you learn it, test it, and build against it today.**

Open the explorer in your browser — no install needed. Walk through each lifecycle step. Edit the FHIR payloads. See what every result code means in plain English. Break things on purpose and learn why they break.

---

## Try It Now

**Zero-install option** — open the **[Live Demo](https://hadijaveed.github.io/access-fhir-apis/)** in any browser. Everything runs client-side — no server needed.

**With the mock server** (for real HTTP request/response):

```bash
git clone <this-repo> && cd access-fhir-sandbox
npm install
npm run start:mock          # → http://localhost:3001
```

Open `http://localhost:3001` — the explorer auto-detects the server and switches to live mode. You'll see a green "Live Server" badge instead of yellow "Simulated".

**Run the test suite:**

```bash
npm run test                # 68+ assertions, all 5 operations, all 4 tracks
```

**Add HAPI FHIR** (optional — for CRUD and profile validation):

```bash
docker compose up -d        # HAPI at http://localhost:8080/fhir
npm run load                # loads 56 IG conformance resources
npm run test                # now runs ~156 assertions across both servers
```

---

## What You Get

### 1. Interactive API Explorer

A single-file web app (`docs/index.html`) that walks you through the complete patient lifecycle:

```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │  ACCESS API Explorer                    [Simulated]  [Reset]  [State]   │
 ├──────────────┬───────────────────────────────────────────────────────────┤
 │              │                                                          │
 │  (1) Screen  │   $check-eligibility — Screen Patient                    │
 │  (2) Enroll  │   POST /fhir/Patient/$check-eligibility                  │
 │  (3) Report  │                                                          │
 │  (4) Poll    │   Scenario: [Eligible eCKM Patient v]                    │
 │  (5) Exit    │   "John Doe has hypertension (I10)..."                   │
 │              │                                                          │
 │  Track:      │   ┌─ Request Payload (editable) ─────────────────────┐   │
 │  [eCKM    v] │   │ { "resourceType": "Parameters", ...             │   │
 │              │   └──────────────────────────────────────────────────┘   │
 │  Alignments: │                                                          │
 │  0           │   [ Send Request ]                                       │
 │              │                                                          │
 │              │   202 Accepted → Polling... → 200 Complete               │
 │              │   Result: "eligible"                                     │
 │              │   ✓ Patient is Eligible                                  │
 │              │   All checks passed. Proceed to Step 2 ($align).         │
 │              │                                                          │
 └──────────────┴──────────────────────────────────────────────────────────┘
```

**What makes it useful:**
- **24 pre-built scenarios** covering every result code — eligible patients, ESRD exclusions, control group assignment, wrong diagnoses, missing measures, timing violations
- **Editable payloads** — change any field (remove the MBI, swap the ICD-10 code) and see how the system responds
- **Plain-English explanations** — every result tells you _what_ happened, _why_, and _what to do next_
- **Track-aware** — switch between eCKM, CKM, MSK, and BH; scenarios adapt with correct ICD-10 codes, LOINC measures, and patient data
- **Two modes, same UI** — runs entirely in-browser (GitHub Pages) or connects to the real mock server when available
- **State inspector** — collapsible panel showing live alignments, submissions, and data reports as you walk through the lifecycle
- **Track Reference** — one-click lookup of valid ICD-10 prefixes, required LOINCs per report type, and OAP outcome targets

### 2. Mock FHIR Server

An Express server (`scripts/mock-access-server.js`) implementing all 5 custom operations with realistic business logic:

| Operation | Endpoint | Result Codes |
|---|---|---|
| Screen | `POST /fhir/Patient/$check-eligibility` | 8 codes |
| Enroll | `POST /fhir/Patient/$align` | 7 codes |
| Report | `POST /fhir/$report-data` | 4 codes |
| Poll | `GET /fhir/Patient/$submission-status` | 3 statuses |
| Exit | `POST /fhir/Patient/$unalign` | 3 codes |

**Business rules enforced:** SHA-256 control group randomization, 90-day lock-in periods, 60-day baseline windows, track-specific ICD-10 validation, LOINC measure requirements per report type, OAP target evaluation at end-of-period.

**Debug endpoints:** `GET /fhir/$mock-state` and `POST /fhir/$mock-reset`

### 3. E2E Test Suite

68 assertions (156 with HAPI) covering every operation, every result code, and every clinical track. Zero dependencies — just `node scripts/test_access_e2e.js`. Auto-detects which servers are online.

### 4. FHIR IG Resources

56 conformance resources from the [published IG](https://github.com/dsacms/cmmi-access-model): CodeSystems, ValueSets, StructureDefinitions, OperationDefinitions, CapabilityStatements, and example Patient/Condition/Parameters resources.

---

## The ACCESS Model Lifecycle

Every patient moves through 5 steps. Each step is a FHIR operation — a custom HTTP endpoint that takes a `Parameters` resource as input and returns structured results.

```
  ┌─────────┐    ┌─────────┐    ┌────────────┐    ┌──────────┐    ┌──────┐
  │ SCREEN  │───>│ ENROLL  │───>│   REPORT   │───>│   POLL   │───>│ EXIT │
  │         │    │         │    │            │    │          │    │      │
  │ $check- │    │ $align  │    │ $report-   │    │$submis-  │    │$un-  │
  │ elig.   │    │         │    │  data      │    │sion-     │    │align │
  └─────────┘    └─────────┘    └────────────┘    │status    │    └──────┘
                                                   └──────────┘
```

### Step 1: Screen — `POST /fhir/Patient/$check-eligibility`

> "Is this Medicare beneficiary eligible for ACCESS in this track?"

You send a `Parameters` resource with the patient (including their MBI), the track, and their condition. CMS runs checks in order:

1. **MBI present?** No MBI → `not-eligible-not-medicare`
2. **Exclusion condition?** ESRD / dialysis / transplant → `not-eligible-services`
3. **Control group?** SHA-256 hash puts 20% of patients in a control arm → `not-eligible-control-group`
4. **Already aligned?** Different participant enrolled them → `not-eligible-already-aligned`
5. **Diagnosis match?** ICD-10 must match track's valid prefixes → `not-eligible-diagnoses`
6. **No condition sent?** → `eligible-pending-diagnosis`
7. **Already aligned, same track?** → `eligible-switch-participants`
8. **All clear** → `eligible`

<details>
<summary>Example payload</summary>

```json
{
  "resourceType": "Parameters",
  "parameter": [
    { "name": "participantID", "valueIdentifier": { "value": "ACCESS1234" } },
    { "name": "payerID", "valueIdentifier": { "value": "12345" } },
    {
      "name": "patient",
      "resource": {
        "resourceType": "Patient",
        "identifier": [{ "system": "http://terminology.hl7.org/NamingSystem/cmsMBI", "value": "1EG4TE5MK73" }],
        "name": [{ "family": "Doe", "given": ["John"] }],
        "gender": "male",
        "birthDate": "1950-01-01"
      }
    },
    {
      "name": "track",
      "valueCodeableConcept": {
        "coding": [{ "system": ".../ACCESSTrackCS", "code": "eCKM" }]
      }
    },
    {
      "name": "condition",
      "resource": {
        "resourceType": "Condition",
        "code": { "coding": [{ "system": "http://hl7.org/fhir/sid/icd-10-cm", "code": "I10", "display": "Essential hypertension" }] }
      }
    }
  ]
}
```

</details>

### Step 2: Enroll — `POST /fhir/Patient/$align`

> "Formally enroll this patient in my program for this track."

Same payload structure, plus `isProviderReferral` (boolean) and optional `switchConsentAttestation` (boolean, required to switch after the 90-day lock-in expires).

**7 result codes:** `aligned`, `aligned-switch-approved`, `not-aligned-already-aligned`, `not-aligned-not-medicare`, `not-aligned-control-group`, `not-aligned-services`, `not-aligned-diagnoses`

**Key rule:** The 90-day lock-in. Once aligned, a patient can't switch participants for 90 days. After that, switching requires `switchConsentAttestation: true`.

### Step 3: Report — `POST /fhir/$report-data`

> "Here are the clinical measurements for this enrolled patient."

The most complex operation. You send a `MeasureReport` plus `Observation` resources with LOINC-coded clinical measures. The server determines the report type from timing:

| Report Type | When | What Happens If Missed |
|---|---|---|
| **Baseline** | Within 60 days of alignment | Auto-unaligned |
| **Quarterly** | 70-110 days after prior report | Gap in trajectory |
| **End-of-Period** | After day 365 (or 185 for BH/MSK early success) | No OAP evaluation |

Each track requires specific LOINC measures:

| Track | Baseline Measures | Key LOINCs |
|---|---|---|
| **eCKM** | 8 biomarkers | BP, LDL, HbA1c, BMI, triglycerides, waist circ., fasting glucose, total cholesterol |
| **CKM** | 4 kidney-focused | HbA1c, eGFR, BP, UACR |
| **MSK** | 3 PROMs | Pain NRS, PROMIS Physical Function, PROMIS Pain Interference |
| **BH** | 2 PROMs | PHQ-9 (depression), GAD-7 (anxiety) |

At end-of-period, the server evaluates **OAP targets** — comparing current vs. baseline values to determine if the patient improved enough (e.g., systolic BP reduced by 10+ mmHg, PHQ-9 score dropped by 5+ points).

**4 result codes:** `accepted`, `rejected-not-aligned`, `rejected-missing-measures`, `rejected-outside-window`

### Step 4: Poll — `GET /fhir/Patient/$submission-status`

> "Did my submission finish processing?"

All operations are async. You get HTTP 202 + a `Content-Location` header. Poll until you get 200 (complete) instead of 202 (pending). The mock simulates this with a configurable delay (default 500ms).

### Step 5: Exit — `POST /fhir/Patient/$unalign`

> "Remove this patient from my program."

Requires a reason: `geographic-relocated`, `loss-of-contact`, `no-longer-clinically-eligible` (must include exclusion condition), or `patient-initiated`.

**3 result codes:** `unaligned`, `unaligned-clinical-exclusion`, `patient-not-aligned`

---

## The 4 Clinical Tracks

| Track | Full Name | Target Population | Example ICD-10 Codes |
|---|---|---|---|
| **eCKM** | Early Cardio-Kidney-Metabolic | Early-stage heart/kidney/metabolic disease | I10 (hypertension), E11 (diabetes), E78 (high cholesterol) |
| **CKM** | Cardio-Kidney-Metabolic | Advanced kidney disease with comorbidities | N18 (CKD), E11 (diabetes), I10 (hypertension) |
| **MSK** | Musculoskeletal | Chronic pain conditions | M17 (knee OA), M54 (back pain), M75 (shoulder) |
| **BH** | Behavioral Health | Depression and anxiety | F32/F33 (depression), F41 (anxiety), F31 (bipolar) |

ICD-10 codes are validated against track-specific prefix lists. Submitting `F32.9` (depression) for the `eCKM` track returns `not-eligible-diagnoses`.

### OAP Targets (Outcome Assessment)

CMS withholds 50% of OAP payments. Participants earn them back if >=50% of patients meet targets:

| Track | Measure | Target |
|---|---|---|
| eCKM | Systolic BP | >=10 mmHg reduction OR <130 mmHg |
| CKM | HbA1c | Any improvement OR <7.0% |
| MSK | Pain NRS | No more than 2-point increase |
| MSK | PROMIS PF | >=2 T-score improvement |
| BH | PHQ-9 | >=5 point reduction OR <5 (remission) |
| BH | GAD-7 | >=4 point reduction OR <5 |

---

## Full Patient Journey Example

An MSK patient (knee osteoarthritis) from screening through exit:

```
Day 0: Screen
  POST $check-eligibility → Patient: Robert Johnson, M17.11 (knee OA)
  → "eligible"

Day 0: Enroll
  POST $align → isProviderReferral: true
  → "aligned" (stored in alignment registry)

Day 30: Baseline Report
  POST $report-data → Pain NRS=7, PROMIS PF=38.2, PROMIS PI=62.1
  → "accepted" (baseline, within 60-day window)

Day 120: Quarterly Report
  POST $report-data → Pain NRS=5, PROMIS PF=42.0, PROMIS PI=56.0
  → "accepted" (quarterly, 90 days since baseline, within 70-110 window)

Day 410: End-of-Period Report
  POST $report-data → Pain NRS=4, PROMIS PF=46.0, PROMIS PI=50.0, PGIC=2
  → "accepted" + OAP: Pain NRS MET, PROMIS PF MET → 2/2 targets, PASSED

Day 425: Exit
  POST $unalign → reason: "geographic-relocated"
  → "unaligned"
```

You can walk through this exact journey in the API Explorer.

---

## Architecture

```
                          ┌──────────────────────────────────────┐
                          │   API Explorer (docs/index.html)     │
                          │                                      │
                          │  Simulated: all logic in-browser     │
                          │  Live: auto-connects to :3001        │
                          └────────────────┬─────────────────────┘
                                           │ auto-detects
┌─────────────────────────────┐     ┌──────┴─────────────────────────────┐
│  HAPI FHIR R4 Server        │     │  Mock ACCESS API Server            │
│  localhost:8080              │     │  localhost:3001                     │
│                              │     │                                    │
│  Stores FHIR resources       │     │  5 custom operations               │
│  Validates against profiles  │     │  In-memory state (4 Maps)          │
│  Hosts 56 IG resources       │     │  Async 202 → poll → 200            │
│  (optional — needs Docker)   │     │  Serves API Explorer               │
└──────────────┬───────────────┘     └──────────────┬─────────────────────┘
               └────────────┬───────────────────────┘
                   test_access_e2e.js (68-156 assertions)
```

### Explorer: Two Modes

|  | Simulated | Live |
|---|---|---|
| **When** | No server (default) | Mock server detected on :3001 |
| **Badge** | Yellow "Simulated" | Green "Live Server" |
| **Logic runs** | In-browser MockEngine | Express server via HTTP |
| **Async** | setTimeout | Real 202 → poll → 200 |
| **State** | Resets on page refresh | Persists until server restart |

Mode detection: on load, the explorer pings `localhost:3001/fhir/metadata`. Response = live. Timeout = simulated. Transparent to the user.

---

## File Structure

```
access-fhir-sandbox/
├── README.md
├── package.json                     # start:mock, test, load, test:full
├── docker-compose.yml               # HAPI FHIR (optional)
│
├── docs/
│   └── index.html                   # API Explorer — single-file, zero dependencies
│                                    # Deploys to GitHub Pages from /docs
│
├── scripts/
│   ├── mock-access-server.js        # Mock server (812 lines)
│   ├── test_access_e2e.js           # E2E tests (1048 lines)
│   └── load_ig_resources.js         # IG loader for HAPI
│
├── ig/                              # 56 FHIR IG resources (v0.9.1)
│   ├── CodeSystem-ACCESS*.json      # Track codes, result codes
│   ├── ValueSet-ACCESS*.json        # ICD-10 value sets per track
│   ├── StructureDefinition-*.json   # FHIR profiles
│   ├── OperationDefinition-*.json   # Operation specifications
│   └── ...                          # Examples, CapabilityStatements
│
└── payloads/                        # Curl-friendly example payloads
    ├── check-eligibility-bh.json
    ├── align-ckm.json
    ├── align-eckm-switch.json
    ├── unalign-geographic.json
    └── unalign-clinical-esrd.json
```

---

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `MOCK_PORT` | `3001` | Mock server port |
| `LOCK_IN_DAYS` | `90` | Days before patient can switch participants |
| `BASELINE_WINDOW_DAYS` | `60` | Days to submit baseline after alignment |
| `ASYNC_DELAY_MS` | `500` | Simulated processing delay (ms) |
| `FHIR_BASE` | `http://localhost:8080/fhir` | HAPI server URL (for tests) |
| `MOCK_BASE` | `http://localhost:3001/fhir` | Mock server URL (for tests) |

---

## Methodology

This project follows a **spec-first, test-everything** approach. Every piece traces back to the published IG and RFA.

### 1. Start from the IG

The [CMS ACCESS Model FHIR IG](https://github.com/dsacms/cmmi-access-model) (v0.9.1) is the single source of truth. All 56 conformance resources — CodeSystems, ValueSets, StructureDefinitions, OperationDefinitions — live in `ig/`. Every constant, validation rule, and result code in the mock server maps directly to these resources.

### 2. Build the server from IG + RFA

Each operation handler walks the IG's result CodeSystem top-to-bottom:
- `$check-eligibility` — 8 result codes from `ACCESSEligibilityResultCS`, ordered by CMS precedence
- `$align` — 7 codes from `ACCESSAlignmentResultCS`, plus the 90-day lock-in from the RFA
- `$report-data` — not yet in the IG (v0.9.1: "Coming in Future Release"), so built from three sources: the RFA's reporting requirements, [Da Vinci DEQM](http://hl7.org/fhir/us/davinci-deqm/) for MeasureReport-based exchange, and [PCO IG](http://hl7.org/fhir/us/pco/) for patient-centered outcomes
- `$unalign` — 3 codes from `ACCESSUnalignmentResultCS`, reason codes from `ACCESSUnalignmentReasonCS`

Control group randomization uses a deterministic SHA-256 hash (`hash[0] % 5 === 0`) for reproducible 20% assignment.

### 3. Test every code path

The test suite was built to reach **every result code in every CodeSystem**. Each test: reset state, set up prerequisites, send request, poll for result, assert the code. Payloads are constructed to trigger specific outcomes — missing MBIs, ESRD conditions, pre-computed control group MBIs, wrong ICD-10 codes, and timing edge cases.

### 4. Build the explorer

Key design decisions:

- **Single file** — one `index.html` with embedded CSS and JS. No build step, no framework, no dependencies. Serves from GitHub Pages, `file://`, or the mock server.
- **Dual-mode** — a `MockEngine` class ports the server's business logic to browser JS (using Web Crypto API for SHA-256). Same scenarios work with or without a server. Mode is auto-detected on page load.
- **Education first** — every result code maps to a plain-English explanation: what happened, why, what to do next. Field guides explain MBIs, LOINCs, and ICD-10 codes. Track Reference shows every valid code per track.
- **Scenarios adapt to track** — switching from eCKM to BH swaps the patient data, ICD-10 codes, and clinical observations. Pre-computed MBI `CTRL0000006` verified to hash into the control group for deterministic demos.

### 5. Integrate without breaking

10 lines added to the mock server: two imports, static file serving from `docs/`, CORS headers, root redirect. All 68 E2E tests pass unchanged.

---

## What's Real vs. What's Mocked

| Aspect | Real CMS API (July 2026) | This Sandbox |
|---|---|---|
| Patient identity | Medicare enrollment database | MBI in Patient.identifier |
| Control group | CMS randomization algorithm | SHA-256 hash, deterministic |
| ICD-10 validation | Claims data cross-reference | Prefix matching against IG value sets |
| Reporting windows | Calendar-based with business days | Day arithmetic from alignment date |
| OAP evaluation | CMS actuarial calculation | Direct baseline-vs-current comparison |
| Async processing | Real queue (minutes/hours) | setTimeout with configurable delay |
| $report-data | Not yet in IG | Built from RFA + DEQM + PCO IG |

---

## Key FHIR Concepts

<details>
<summary>New to FHIR? Expand for a quick primer on the concepts used here.</summary>

### Operations (the `$` prefix)

Standard FHIR is CRUD: `GET /Patient/123`, `PUT /Patient/123`. **Operations** add custom RPC-style endpoints prefixed with `$`. They take `Parameters` resources as input and return `Parameters` or `OperationOutcome` as output. The ACCESS API defines 5 custom operations.

### Parameters Resource

The universal input/output container. Each `parameter` has a `name` and one value field (`valueString`, `valueBoolean`, `valueIdentifier`, `valueCodeableConcept`, or `resource`).

### MeasureReport + Observation

`MeasureReport` describes _what_ is being reported (track, patient, date). `Observation` resources carry the actual clinical data — each has a LOINC code identifying the measure and a value (integer or quantity).

### CodeSystem / ValueSet

The IG defines custom code systems (`ACCESSTrackCS`, `ACCESSEligibilityResultCS`, etc.) with enumerated allowed values. ValueSets bind ICD-10 codes to specific tracks.

### OperationOutcome

FHIR's standard error/info response. Returned for 202 (accepted), 400 (bad request), and 404 (not found).

</details>

---

## GitHub Pages Deployment

1. Push to GitHub
2. Settings > Pages > Source: Deploy from branch > folder: `/docs`
3. Done — the explorer is live, no build step needed

All scenarios work in simulated mode. Users who clone and run `npm run start:mock` get live mode automatically.
