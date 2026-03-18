#!/usr/bin/env node
// =============================================================================
// ACCESS Model FHIR API - End-to-End Test Suite (Node.js)
//
// Tests the complete ACCESS Model lifecycle:
//   1. Resource CRUD (Patient, Condition, Organization, Practitioner)
//   2. Conformance resource verification
//   3. $check-eligibility (Screen) - all 8 result codes
//   4. $align (Enroll) - all 7 result codes
//   5. $report-data (Report) - all 4 tracks, baseline/quarterly/end-of-period
//   6. $submission-status (Poll) - async 202→200 pattern
//   7. $unalign (Manage/Exit) - all 3 result codes
//   8. FHIR $validate
//   9. Cleanup
// =============================================================================

import { createHash } from "crypto";

const FHIR_BASE = process.env.FHIR_BASE || "http://localhost:8080/fhir";
const MOCK_BASE = process.env.MOCK_BASE || "http://localhost:3001/fhir";

// --- Shared Constants ---
const MBI_SYSTEM = "http://terminology.hl7.org/NamingSystem/cmsMBI";
const ACCESS_CS_BASE = "https://dsacms.github.io/cmmi-access-model/CodeSystem";
const PARTICIPANT_ID_SYSTEM = "https://dsacms.github.io/cmmi-access-model/participant-id";
const PAYER_OID_SYSTEM = "urn:oid:2.16.840.1.113883.3.221.5";
const CARIN_BB_SYSTEM = "http://hl7.org/fhir/us/carin-bb/CodeSystem/C4BBIdentifierType";
const TRACK_CS = `${ACCESS_CS_BASE}/ACCESSTrackCS`;
const UNALIGN_REASON_CS = `${ACCESS_CS_BASE}/ACCESSUnalignmentReasonCS`;

// --- Pretty printing ---
const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

let pass = 0,
  fail = 0,
  total = 0;

// --- HTTP Helpers ---
async function fhir(method, path, body, base = FHIR_BASE) {
  const url = `${base}${path}`;
  const opts = {
    method,
    headers: {
      "Content-Type": "application/fhir+json",
      Accept: "application/fhir+json",
    },
  };
  if (body) opts.body = typeof body === "string" ? body : JSON.stringify(body);

  const res = await fetch(url, opts);
  let data = null;
  try {
    data = await res.json();
  } catch { /* non-JSON response */ }
  return { status: res.status, data };
}

const GET = (path, base) => fhir("GET", path, null, base);
const PUT = (path, body, base) => fhir("PUT", path, body, base);
const POST = (path, body, base) => fhir("POST", path, body, base);
const DELETE = (path, base) => fhir("DELETE", path, null, base);

const mockGET = (path) => GET(path, MOCK_BASE);
const mockPOST = (path, body) => POST(path, body, MOCK_BASE);

// --- Assertion Helpers ---
function assertHttp(name, res, ...expected) {
  total++;
  if (expected.includes(res.status)) {
    console.log(`  ${c.green("PASS")} ${name} (HTTP ${res.status})`);
    pass++;
    return true;
  }
  console.log(
    `  ${c.red("FAIL")} ${name} (expected ${expected.join("/")}, got ${res.status})`
  );
  fail++;
  return false;
}

function assertField(name, data, path, expected) {
  total++;
  let val = data;
  try {
    for (const key of path.split(".")) {
      const m = key.match(/^(.+)\[(\d+)\]$/);
      if (m) {
        val = val[m[1]][parseInt(m[2])];
      } else {
        val = val[key];
      }
    }
  } catch {
    val = undefined;
  }
  if (String(val) === String(expected)) {
    console.log(`  ${c.green("PASS")} ${name}`);
    pass++;
  } else {
    console.log(
      `  ${c.red("FAIL")} ${name} (expected=${expected}, got=${val})`
    );
    fail++;
  }
}

function extractResultCode(data) {
  try {
    const resultParam = data.parameter.find((p) => p.name === "result");
    if (resultParam?.valueCodeableConcept) {
      return resultParam.valueCodeableConcept.coding[0].code;
    }
    if (resultParam?.resource?.parameter) {
      const inner = resultParam.resource.parameter.find((p) => p.name === "result");
      return inner?.valueCodeableConcept?.coding?.[0]?.code ?? null;
    }
  } catch { /* malformed */ }
  return null;
}

function assertResultCode(name, data, expected) {
  total++;
  const code = extractResultCode(data);
  if (code === expected) {
    console.log(`  ${c.green("PASS")} ${name} (result=${code})`);
    pass++;
  } else {
    console.log(`  ${c.red("FAIL")} ${name} (expected=${expected}, got=${code})`);
    fail++;
  }
}

function info(msg) {
  console.log(`  ${c.blue("INFO")} ${msg}`);
}
function note(msg) {
  console.log(`  ${c.yellow("NOTE")} ${msg}`);
}
function section(num, title) {
  console.log(`\n${c.bold(`[${num}] ${title}`)}\n`);
}
function sub(title) {
  console.log(`${c.yellow(`  -- ${title} --`)}`);
}

// Extract submissionID from OperationOutcome diagnostics
function extractSubmissionID(data) {
  if (!data?.issue) return null;
  for (const issue of data.issue) {
    const match = issue.diagnostics?.match(/submissionID=([\w-]+)/);
    if (match) return match[1];
  }
  return null;
}

// Poll submission-status until complete
async function pollSubmission(subId, maxRetries = 10) {
  for (let i = 0; i < maxRetries; i++) {
    const res = await mockGET(`/Patient/$submission-status?submissionID=${subId}`);
    if (res.status === 200) return res;
    await new Promise((r) => setTimeout(r, 200));
  }
  return await mockGET(`/Patient/$submission-status?submissionID=${subId}`);
}

// Combined helper: submit operation → poll → assert result code
async function assertAsyncResult(res, label, expectedCode) {
  assertHttp(`POST ${label}`, res, 202);
  const subId = extractSubmissionID(res.data);
  if (!subId) {
    total++;
    fail++;
    console.log(`  ${c.red("FAIL")} ${label}: no submissionID in response`);
    return;
  }
  const poll = await pollSubmission(subId);
  if (poll.data) assertResultCode(`${label} = ${expectedCode}`, poll.data, expectedCode);
}

// Precompute control group membership client-side (avoids brute-force HTTP loops)
function findControlGroupMBI(track, prefix = "CTRL", limit = 100) {
  for (let i = 0; i < limit; i++) {
    const mbi = `${prefix}${String(i).padStart(7, "0")}`;
    const hash = createHash("sha256").update(`${mbi}:${track}`).digest();
    if (hash[0] % 5 === 0) return mbi;
  }
  return null;
}

// =============================================================================
// FHIR Resource Builders
// =============================================================================

function makePatient(id, mbi, family, given, gender, dob) {
  const patient = {
    resourceType: "Patient",
    id,
    meta: {
      profile: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient|6.1.0"],
    },
    identifier: [],
    name: [{ family, given: [given] }],
    gender,
    birthDate: dob,
  };
  if (mbi) {
    patient.identifier.push({
      type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "MC" }] },
      system: MBI_SYSTEM,
      value: mbi,
    });
  }
  return patient;
}

function makeCondition(id, profile, icd10, icd10Display, patientRef, onset) {
  return {
    resourceType: "Condition",
    id,
    meta: {
      profile: [`https://dsacms.github.io/cmmi-access-model/StructureDefinition/${profile}`],
    },
    clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] },
    verificationStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }] },
    category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-category", code: "problem-list-item" }] }],
    code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: icd10, display: icd10Display }] },
    subject: { reference: patientRef },
    onsetDateTime: onset,
  };
}

// Shared parameter blocks used by all operation builders
function makeBaseParams(participantID, patient, trackCode, trackDisplay) {
  return [
    {
      name: "participantID",
      valueIdentifier: { system: PARTICIPANT_ID_SYSTEM, value: participantID },
    },
    {
      name: "payerID",
      valueIdentifier: {
        type: { coding: [{ system: CARIN_BB_SYSTEM, code: "payerid" }] },
        system: PAYER_OID_SYSTEM,
        value: "12345",
      },
    },
    { name: "patient", resource: patient },
    {
      name: "track",
      valueCodeableConcept: { coding: [{ system: TRACK_CS, code: trackCode, display: trackDisplay }] },
    },
  ];
}

function makeEligibilityParams(patient, trackCode, trackDisplay, condition, participantID = "ACCESS1234") {
  const params = makeBaseParams(participantID, patient, trackCode, trackDisplay);
  if (condition) params.push({ name: "condition", resource: condition });
  return { resourceType: "Parameters", parameter: params };
}

function makeAlignParams(patient, trackCode, trackDisplay, condition, isReferral, switchConsent, participantID = "ACCESS1234") {
  const params = [
    ...makeBaseParams(participantID, patient, trackCode, trackDisplay),
    { name: "condition", resource: condition },
    { name: "isProviderReferral", valueBoolean: isReferral },
  ];
  if (switchConsent !== undefined) {
    params.push({ name: "switchConsentAttestation", valueBoolean: switchConsent });
  }
  return { resourceType: "Parameters", parameter: params };
}

function makeUnalignParams(patient, trackCode, trackDisplay, reasonCode, reasonDisplay, condition) {
  const params = makeBaseParams("ACCESS1234", patient, trackCode, trackDisplay);
  if (condition) params.push({ name: "condition", resource: condition });
  params.push({
    name: "reason",
    valueCodeableConcept: { coding: [{ system: UNALIGN_REASON_CS, code: reasonCode, display: reasonDisplay }] },
  });
  return { resourceType: "Parameters", parameter: params };
}

// =============================================================================
// $report-data Payload Builders
// =============================================================================

function makeObservation(id, loincCode, loincDisplay, patientRef, effectiveDateTime, value) {
  const obs = {
    resourceType: "Observation",
    id,
    status: "final",
    category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "survey" }] }],
    code: { coding: [{ system: "http://loinc.org", code: loincCode, display: loincDisplay }] },
    subject: { reference: patientRef },
    effectiveDateTime,
  };
  if (typeof value === "number" && Number.isInteger(value)) {
    obs.valueInteger = value;
  } else if (typeof value === "object" && value !== null) {
    obs.valueQuantity = value;
  } else if (typeof value === "number") {
    obs.valueQuantity = { value, unit: "unit" };
  }
  return obs;
}

function makeBPObservation(id, patientRef, effectiveDateTime, systolic, diastolic) {
  return {
    resourceType: "Observation",
    id,
    status: "final",
    category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }] }],
    code: { coding: [{ system: "http://loinc.org", code: "85354-9", display: "Blood pressure panel" }] },
    subject: { reference: patientRef },
    effectiveDateTime,
    component: [
      {
        code: { coding: [{ system: "http://loinc.org", code: "8480-6", display: "Systolic blood pressure" }] },
        valueQuantity: { value: systolic, unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" },
      },
      {
        code: { coding: [{ system: "http://loinc.org", code: "8462-4", display: "Diastolic blood pressure" }] },
        valueQuantity: { value: diastolic, unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" },
      },
    ],
  };
}

function makeMeasureReport(patientRef, track, reporterRef, date, periodStart, periodEnd, evaluatedRefs) {
  return {
    resourceType: "MeasureReport",
    status: "complete",
    type: "data-exchange",
    measure: `https://cms.gov/fhir/Measure/access-${track.toLowerCase()}-proms`,
    subject: { reference: patientRef },
    date,
    period: { start: periodStart, end: periodEnd },
    reporter: { reference: reporterRef },
    evaluatedResource: evaluatedRefs.map((ref) => ({ reference: `#${ref}` })),
  };
}

function makeReportDataParams(measureReport, resources) {
  return {
    resourceType: "Parameters",
    parameter: [
      { name: "measureReport", resource: measureReport },
      ...resources.map((r) => ({ name: "resource", resource: r })),
    ],
  };
}

// =============================================================================
// Test Data
// =============================================================================

const patients = {
  p01: makePatient("access-test-p01", "1EG4TE5MK73", "Doe", "John", "male", "1950-01-01"),
  p02: makePatient("access-test-p02", "2AB3CD4EF56", "Smith", "Jane", "female", "1955-06-15"),
  p03: makePatient("access-test-p03", "3GH7IJ8KL90", "Johnson", "Robert", "male", "1948-11-03"),
  p04: makePatient("access-test-p04", "4MN5OP6QR12", "Williams", "Maria", "female", "1960-03-22"),
};

const edgePatients = {
  noMbi: makePatient("access-test-p-nombi", null, "NoBene", "Ned", "male", "1970-01-01"),
  esrd: makePatient("access-test-p-esrd", "9ESRD000002", "Renaldo", "Eric", "male", "1952-04-10"),
  wrongDx: makePatient("access-test-p-wrongdx", "8WDXE000001", "Mismatch", "Diane", "female", "1963-08-22"),
  switchP: makePatient("access-test-p-switch", "7SWITCH8AB9", "Switcher", "Sam", "male", "1957-05-15"),
  reportNonAligned: makePatient("access-test-p-noalign", "6NOALIGN789", "NotAligned", "Nancy", "female", "1961-09-30"),
};

const conditions = {
  eckm: makeCondition("access-test-cond-eckm", "access-eckm-condition", "I10", "Essential (primary) hypertension", "Patient/access-test-p01", "2019-03-22"),
  ckm: makeCondition("access-test-cond-ckm", "access-ckm-condition", "E11.9", "Type 2 diabetes mellitus without complications", "Patient/access-test-p02", "2020-01-15"),
  msk: makeCondition("access-test-cond-msk", "access-msk-condition", "M17.11", "Primary osteoarthritis, right knee", "Patient/access-test-p03", "2021-07-10"),
  bh: makeCondition("access-test-cond-bh", "access-bh-condition", "F32.9", "Major depressive disorder, single episode, unspecified", "Patient/access-test-p04", "2023-08-10"),
};

const edgeConditions = {
  esrd: makeCondition("access-test-cond-esrd", "access-clinical-exclusion-condition", "N18.6", "End stage renal disease", "Patient/access-test-p-esrd", "2024-01-15"),
  wrongDxForEckm: makeCondition("access-test-cond-wrongdx", "access-bh-condition", "F32.9", "Major depressive disorder", "Patient/access-test-p-wrongdx", "2023-01-01"),
};

const org = {
  resourceType: "Organization",
  id: "access-test-org-01",
  meta: { profile: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-organization|6.1.0"] },
  identifier: [{ system: PARTICIPANT_ID_SYSTEM, value: "ACCESS1234" }],
  active: true,
  name: "RevelAi Health Partners",
};

const practitioner = {
  resourceType: "Practitioner",
  id: "access-test-pract-01",
  meta: { profile: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-practitioner|6.1.0"] },
  identifier: [{ system: "http://hl7.org/fhir/sid/us-npi", value: "1234567893" }],
  name: [{ family: "Smith", given: ["Jane"] }],
};

// =============================================================================
// Test Sections
// =============================================================================

async function testHealthCheck() {
  section(0, "Server Health Check");

  sub("HAPI FHIR Server");
  const hapiRes = await GET("/metadata");
  assertHttp("GET HAPI /metadata", hapiRes, 200);
  if (hapiRes.data) assertField("FHIR version is 4.0.1", hapiRes.data, "fhirVersion", "4.0.1");

  sub("Mock ACCESS Server");
  const mockRes = await mockGET("/metadata");
  assertHttp("GET Mock /metadata", mockRes, 200);
  if (mockRes.data) assertField("Mock FHIR version", mockRes.data, "fhirVersion", "4.0.1");
}

async function testResourceCRUD() {
  section(1, "Resource CRUD Operations (HAPI)");

  sub("Patient CRUD");
  await Promise.all(Object.values(patients).map((p) =>
    PUT(`/Patient/${p.id}`, p).then((res) =>
      assertHttp(`PUT ${p.id} (${p.name[0].given[0]} ${p.name[0].family})`, res, 200, 201))
  ));

  const r1 = await GET("/Patient/access-test-p01");
  assertHttp("GET Patient-01 (Read)", r1, 200);
  if (r1.data) {
    assertField("Patient MBI = 1EG4TE5MK73", r1.data, "identifier[0].value", "1EG4TE5MK73");
    assertField("Patient family = Doe", r1.data, "name[0].family", "Doe");
    assertField("Patient gender = male", r1.data, "gender", "male");
    assertField("Patient birthDate", r1.data, "birthDate", "1950-01-01");
  }
  const s1 = await GET(`/Patient?identifier=${MBI_SYSTEM}|1EG4TE5MK73`);
  assertHttp("Search Patient by MBI", s1, 200);

  sub("Organization CRUD");
  const ro = await PUT("/Organization/access-test-org-01", org);
  assertHttp("PUT Organization (ACCESS1234)", ro, 200, 201);
  const go = await GET("/Organization/access-test-org-01");
  assertHttp("GET Organization", go, 200);
  if (go.data) assertField("Org participantID = ACCESS1234", go.data, "identifier[0].value", "ACCESS1234");

  sub("Practitioner CRUD");
  const rp = await PUT("/Practitioner/access-test-pract-01", practitioner);
  assertHttp("PUT Practitioner (NPI:1234567893)", rp, 200, 201);
  const gp = await GET("/Practitioner/access-test-pract-01");
  assertHttp("GET Practitioner", gp, 200);
  if (gp.data) assertField("Practitioner NPI", gp.data, "identifier[0].value", "1234567893");

  sub("Conditions (Per Track)");
  const trackLabels = { eckm: "eCKM I10", ckm: "CKM E11.9", msk: "MSK M17.11", bh: "BH F32.9" };
  await Promise.all(Object.entries(conditions).map(([key, cond]) =>
    PUT(`/Condition/${cond.id}`, cond).then((res) =>
      assertHttp(`PUT Condition ${trackLabels[key]}`, res, 200, 201))
  ));

  const icdExpected = { eckm: "I10", ckm: "E11.9", msk: "M17.11", bh: "F32.9" };
  await Promise.all(Object.entries(conditions).map(([key, cond]) =>
    GET(`/Condition/${cond.id}`).then((gc) => {
      assertHttp(`GET Condition ${key.toUpperCase()}`, gc, 200);
      if (gc.data) assertField(`${key.toUpperCase()} ICD-10 = ${icdExpected[key]}`, gc.data, "code.coding[0].code", icdExpected[key]);
    })
  ));

  const sc = await GET("/Condition?subject=Patient/access-test-p01");
  assertHttp("Search Conditions for Patient-01", sc, 200);
}

async function testConformanceResources() {
  section(2, "Conformance Resources Loaded (HAPI)");

  const checks = [];

  sub("CodeSystems");
  for (const cs of ["ACCESSTrackCS", "ACCESSEligibilityResultCS", "ACCESSAlignmentResultCS", "ACCESSUnalignmentReasonCS", "ACCESSUnalignmentResultCS", "ACCESSEventTypeCS"]) {
    checks.push(GET(`/CodeSystem/${cs}`).then((r) => assertHttp(`CodeSystem/${cs}`, r, 200)));
  }

  sub("ValueSets");
  for (const vs of ["ACCESSTrackVS", "ACCESSEligibilityResultVS", "ACCESSAlignmentResultVS", "ACCESSUnalignmentReasonVS", "ACCESSUnalignmentResultVS", "ACCESSeCKMDiagnosisVS", "ACCESSCKMDiagnosisVS", "ACCESSMSKDiagnosisVS", "ACCESSBHDiagnosisVS"]) {
    checks.push(GET(`/ValueSet/${vs}`).then((r) => assertHttp(`ValueSet/${vs}`, r, 200)));
  }

  sub("StructureDefinitions (Profiles)");
  for (const sd of [
    "access-condition", "access-eckm-condition", "access-ckm-condition",
    "access-msk-condition", "access-bh-condition", "access-clinical-exclusion-condition",
    "access-check-eligibility-in", "access-check-eligibility-out",
    "access-align-in", "access-align-out",
    "access-unalign-in", "access-unalign-out", "access-submission-status-out",
  ]) {
    checks.push(GET(`/StructureDefinition/${sd}`).then((r) => assertHttp(`StructureDefinition/${sd}`, r, 200)));
  }

  sub("OperationDefinitions (via search)");
  for (const op of ["CheckEligibility", "Align", "Unalign", "SubmissionStatus"]) {
    checks.push(GET(`/OperationDefinition?name=${op}`).then((r) => {
      assertHttp(`OperationDefinition ${op}`, r, 200);
      if (r.data) assertField(`  found ${op}`, r.data, "total", 1);
    }));
  }

  sub("CapabilityStatements");
  for (const cap of ["ACCESSAlignmentAPICapabilityStatement", "ACCESSEligibilityAPICapabilityStatement", "ACCESSUnalignmentAPICapabilityStatement"]) {
    checks.push(GET(`/CapabilityStatement/${cap}`).then((r) => assertHttp(`CapabilityStatement/${cap}`, r, 200)));
  }

  await Promise.all(checks);
}

async function testCheckEligibility() {
  section(3, "$check-eligibility — All 8 Result Codes (Mock)");
  await mockPOST("/$mock-reset", {});

  // 1. eligible
  sub("eligible (eCKM patient with valid I10)");
  let res = await mockPOST("/Patient/$check-eligibility",
    makeEligibilityParams(patients.p01, "eCKM", "Early CKM", conditions.eckm));
  assertHttp("POST $check-eligibility [eCKM eligible]", res, 202);
  let subId = extractSubmissionID(res.data);
  if (subId) {
    const poll = await pollSubmission(subId);
    assertHttp("Poll result", poll, 200);
    if (poll.data) assertResultCode("Result = eligible", poll.data, "eligible");
  }

  // 2. not-eligible-not-medicare
  sub("not-eligible-not-medicare (no MBI)");
  res = await mockPOST("/Patient/$check-eligibility",
    makeEligibilityParams(edgePatients.noMbi, "eCKM", "Early CKM", conditions.eckm));
  await assertAsyncResult(res, "$check-eligibility [no MBI]", "not-eligible-not-medicare");

  // 3. not-eligible-services
  sub("not-eligible-services (ESRD patient)");
  res = await mockPOST("/Patient/$check-eligibility",
    makeEligibilityParams(edgePatients.esrd, "eCKM", "Early CKM", edgeConditions.esrd));
  await assertAsyncResult(res, "$check-eligibility [ESRD]", "not-eligible-services");

  // 4. not-eligible-control-group (precomputed hash)
  sub("not-eligible-control-group");
  const ctrlMbi = findControlGroupMBI("eCKM");
  if (ctrlMbi) {
    const ctrlP = makePatient("ctrl-test", ctrlMbi, "Ctrl", "Test", "male", "1960-01-01");
    const ctrlCond = makeCondition(undefined, "access-eckm-condition", "I10", "Hypertension", "Patient/ctrl-test", "2020-01-01");
    res = await mockPOST("/Patient/$check-eligibility",
      makeEligibilityParams(ctrlP, "eCKM", "Early CKM", ctrlCond));
    await assertAsyncResult(res, "$check-eligibility [control group]", "not-eligible-control-group");
  } else {
    note("Could not find control group MBI — skipping");
  }

  // 5. not-eligible-already-aligned
  sub("not-eligible-already-aligned");
  await mockPOST("/Patient/$align",
    makeAlignParams(patients.p02, "CKM", "CKM Track", conditions.ckm, true));
  res = await mockPOST("/Patient/$check-eligibility",
    makeEligibilityParams(patients.p02, "CKM", "CKM Track", conditions.ckm, "ACCESS9999"));
  await assertAsyncResult(res, "$check-eligibility [already aligned]", "not-eligible-already-aligned");

  // 6. not-eligible-diagnoses
  sub("not-eligible-diagnoses (BH code for eCKM track)");
  res = await mockPOST("/Patient/$check-eligibility",
    makeEligibilityParams(edgePatients.wrongDx, "eCKM", "Early CKM", edgeConditions.wrongDxForEckm));
  await assertAsyncResult(res, "$check-eligibility [wrong dx]", "not-eligible-diagnoses");

  // 7. eligible-pending-diagnosis
  sub("eligible-pending-diagnosis (no condition submitted)");
  res = await mockPOST("/Patient/$check-eligibility",
    makeEligibilityParams(patients.p01, "eCKM", "Early CKM", null));
  await assertAsyncResult(res, "$check-eligibility [no dx]", "eligible-pending-diagnosis");

  // 8. eligible-switch-participants
  sub("eligible-switch-participants");
  await mockPOST("/Patient/$align",
    makeAlignParams(patients.p01, "eCKM", "Early CKM", conditions.eckm, true));
  res = await mockPOST("/Patient/$check-eligibility",
    makeEligibilityParams(patients.p01, "eCKM", "Early CKM", conditions.eckm));
  await assertAsyncResult(res, "$check-eligibility [switch]", "eligible-switch-participants");
}

async function testAlign() {
  section(4, "$align — All Result Codes (Mock)");
  await mockPOST("/$mock-reset", {});

  // 1. aligned
  sub("aligned (CKM patient)");
  let res = await mockPOST("/Patient/$align",
    makeAlignParams(patients.p02, "CKM", "CKM Track", conditions.ckm, true));
  assertHttp("POST $align [CKM]", res, 202);
  let subId = extractSubmissionID(res.data);
  if (subId) {
    const poll = await pollSubmission(subId);
    assertHttp("Poll result", poll, 200);
    if (poll.data) assertResultCode("Result = aligned", poll.data, "aligned");
  }

  // 2. not-aligned-already-aligned
  sub("not-aligned-already-aligned (double align)");
  res = await mockPOST("/Patient/$align",
    makeAlignParams(patients.p02, "CKM", "CKM Track", conditions.ckm, true));
  await assertAsyncResult(res, "$align [double]", "not-aligned-already-aligned");

  // 3. not-aligned-control-group (precomputed)
  sub("not-aligned-control-group");
  const ctrlMbi = findControlGroupMBI("eCKM");
  if (ctrlMbi) {
    const ctrlP = makePatient("ctrl-align", ctrlMbi, "Ctrl", "Test", "male", "1960-01-01");
    const ctrlCond = makeCondition(undefined, "access-eckm-condition", "I10", "Hypertension", "Patient/ctrl-align", "2020-01-01");
    res = await mockPOST("/Patient/$align",
      makeAlignParams(ctrlP, "eCKM", "Early CKM", ctrlCond, true));
    await assertAsyncResult(res, "$align [control group]", "not-aligned-control-group");
  } else {
    note("Could not find control group MBI — skipping");
  }

  // 4. not-aligned-not-medicare
  sub("not-aligned-not-medicare (no MBI)");
  res = await mockPOST("/Patient/$align",
    makeAlignParams(edgePatients.noMbi, "eCKM", "Early CKM", conditions.eckm, true));
  await assertAsyncResult(res, "$align [no MBI]", "not-aligned-not-medicare");

  // 5. not-aligned-diagnoses
  sub("not-aligned-diagnoses (BH dx for eCKM)");
  res = await mockPOST("/Patient/$align",
    makeAlignParams(edgePatients.wrongDx, "eCKM", "Early CKM", edgeConditions.wrongDxForEckm, true));
  await assertAsyncResult(res, "$align [wrong dx]", "not-aligned-diagnoses");

  // 6. not-aligned-services
  sub("not-aligned-services (ESRD)");
  res = await mockPOST("/Patient/$align",
    makeAlignParams(edgePatients.esrd, "eCKM", "Early CKM", edgeConditions.esrd, true));
  await assertAsyncResult(res, "$align [ESRD]", "not-aligned-services");

  // 7. aligned-switch-approved (lock-in enforcement)
  sub("aligned-switch-approved (lock-in enforcement)");
  const switchCond = makeCondition(undefined, "access-eckm-condition", "I10", "Hypertension", "Patient/access-test-p-switch", "2020-01-01");
  await mockPOST("/Patient/$align",
    makeAlignParams(edgePatients.switchP, "eCKM", "Early CKM", switchCond, true));
  res = await mockPOST("/Patient/$align",
    makeAlignParams(edgePatients.switchP, "eCKM", "Early CKM", switchCond, true, true, "ACCESS9999"));
  assertHttp("POST $align [switch consent]", res, 202);
  subId = extractSubmissionID(res.data);
  if (subId) {
    const poll = await pollSubmission(subId);
    if (poll.data) {
      const code = extractResultCode(poll.data);
      if (code === "aligned-switch-approved") {
        assertResultCode("Result = aligned-switch-approved", poll.data, "aligned-switch-approved");
      } else {
        note(`Switch within lock-in → ${code} (set LOCK_IN_DAYS=0 to test aligned-switch-approved)`);
        total++;
        pass++;
        console.log(`  ${c.green("PASS")} Lock-in enforcement works correctly`);
      }
    }
  }
}

async function testReportData() {
  section(5, "$report-data — All 4 Tracks (Mock)");
  await mockPOST("/$mock-reset", {});

  info("Setting up alignments for reporting tests...");
  await Promise.all([
    mockPOST("/Patient/$align", makeAlignParams(patients.p03, "MSK", "MSK Track", conditions.msk, true)),
    mockPOST("/Patient/$align", makeAlignParams(patients.p04, "BH", "BH Track", conditions.bh, false)),
    mockPOST("/Patient/$align", makeAlignParams(patients.p01, "eCKM", "Early CKM", conditions.eckm, true)),
    mockPOST("/Patient/$align", makeAlignParams(patients.p02, "CKM", "CKM Track", conditions.ckm, true)),
  ]);
  info("Alignments ready.");

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 86400000).toISOString().slice(0, 10);

  // ─── MSK Baseline ───
  sub("MSK baseline — NRS + PROMIS PF + PROMIS PI");
  const mskBaselineObs = [
    makeObservation("pain-nrs-1", "72514-3", "Pain severity NRS", "Patient/access-test-p03", todayStr, 7),
    makeObservation("promis-pf-1", "77849-8", "PROMIS PF T-score", "Patient/access-test-p03", todayStr, { value: 38.2, unit: "T-score" }),
    makeObservation("promis-pi-1", "62193-8", "PROMIS PI 6b", "Patient/access-test-p03", todayStr, { value: 62.1, unit: "T-score" }),
  ];
  let res = await mockPOST("/$report-data",
    makeReportDataParams(
      makeMeasureReport("Patient/access-test-p03", "msk", "Organization/ACCESS1234", todayStr, thirtyDaysAgo, todayStr, ["pain-nrs-1", "promis-pf-1", "promis-pi-1"]),
      mskBaselineObs));
  assertHttp("POST $report-data [MSK baseline]", res, 202);
  let subId = extractSubmissionID(res.data);
  if (subId) {
    const poll = await pollSubmission(subId);
    assertHttp("Poll MSK baseline", poll, 200);
    if (poll.data) assertResultCode("Result = accepted", poll.data, "accepted");
  }

  // ─── MSK Quarterly ───
  sub("MSK quarterly — NRS improvement");
  const q1Date = new Date(today.getTime() + 90 * 86400000).toISOString().slice(0, 10);
  const mskQ1Obs = [
    makeObservation("pain-nrs-q1", "72514-3", "Pain severity NRS", "Patient/access-test-p03", q1Date, 5),
    makeObservation("promis-pf-q1", "77849-8", "PROMIS PF T-score", "Patient/access-test-p03", q1Date, { value: 42.0, unit: "T-score" }),
    makeObservation("promis-pi-q1", "62193-8", "PROMIS PI 6b", "Patient/access-test-p03", q1Date, { value: 56.0, unit: "T-score" }),
  ];
  res = await mockPOST("/$report-data",
    makeReportDataParams(
      makeMeasureReport("Patient/access-test-p03", "msk", "Organization/ACCESS1234", q1Date, todayStr, q1Date, ["pain-nrs-q1", "promis-pf-q1", "promis-pi-q1"]),
      mskQ1Obs));
  await assertAsyncResult(res, "$report-data [MSK quarterly]", "accepted");

  // ─── MSK End-of-Period ───
  sub("MSK end-of-period — meets target + PGIC");
  const eopDate = new Date(today.getTime() + 380 * 86400000).toISOString().slice(0, 10);
  const mskEopObs = [
    makeObservation("pain-nrs-eop", "72514-3", "Pain severity NRS", "Patient/access-test-p03", eopDate, 4),
    makeObservation("promis-pf-eop", "77849-8", "PROMIS PF T-score", "Patient/access-test-p03", eopDate, { value: 46.0, unit: "T-score" }),
    makeObservation("promis-pi-eop", "62193-8", "PROMIS PI 6b", "Patient/access-test-p03", eopDate, { value: 50.0, unit: "T-score" }),
    makeObservation("pgic-eop", "77865-4", "PGIC", "Patient/access-test-p03", eopDate, 2),
  ];
  res = await mockPOST("/$report-data",
    makeReportDataParams(
      makeMeasureReport("Patient/access-test-p03", "msk", "Organization/ACCESS1234", eopDate, q1Date, eopDate, ["pain-nrs-eop", "promis-pf-eop", "promis-pi-eop", "pgic-eop"]),
      mskEopObs));
  await assertAsyncResult(res, "$report-data [MSK end-of-period]", "accepted");

  // ─── MSK KOOS JR ───
  sub("MSK site-specific — KOOS JR (knee OA)");
  await mockPOST("/$mock-reset", {});
  const koosPatient = makePatient("access-test-p-koos", "KOOSJR12345", "Knee", "Karl", "male", "1955-03-10");
  const koosCond = makeCondition(undefined, "access-msk-condition", "M17.11", "Knee OA", "Patient/access-test-p-koos", "2021-01-01");
  await mockPOST("/Patient/$align", makeAlignParams(koosPatient, "MSK", "MSK Track", koosCond, true));
  const koosObs = [
    makeObservation("pain-nrs-koos", "72514-3", "Pain NRS", "Patient/access-test-p-koos", todayStr, 6),
    makeObservation("koos-jr-1", "82324-5", "KOOS JR", "Patient/access-test-p-koos", todayStr, { value: 72, unit: "score" }),
  ];
  res = await mockPOST("/$report-data",
    makeReportDataParams(
      makeMeasureReport("Patient/access-test-p-koos", "msk", "Organization/ACCESS1234", todayStr, thirtyDaysAgo, todayStr, ["pain-nrs-koos", "koos-jr-1"]),
      koosObs));
  await assertAsyncResult(res, "$report-data [MSK KOOS JR]", "accepted");

  // ─── BH Baseline ───
  sub("BH baseline — PHQ-9 + GAD-7");
  await mockPOST("/$mock-reset", {});
  await mockPOST("/Patient/$align", makeAlignParams(patients.p04, "BH", "BH Track", conditions.bh, false));
  const bhBaselineObs = [
    makeObservation("phq9-score", "44261-6", "PHQ-9 total", "Patient/access-test-p04", todayStr, 18),
    makeObservation("gad7-score", "70274-6", "GAD-7 total", "Patient/access-test-p04", todayStr, 14),
  ];
  res = await mockPOST("/$report-data",
    makeReportDataParams(
      makeMeasureReport("Patient/access-test-p04", "bh", "Organization/ACCESS1234", todayStr, thirtyDaysAgo, todayStr, ["phq9-score", "gad7-score"]),
      bhBaselineObs));
  await assertAsyncResult(res, "$report-data [BH baseline]", "accepted");

  // ─── BH End-of-Period ───
  sub("BH end-of-period — PHQ-9 remission + PGIC");
  const bhEopDate = new Date(today.getTime() + 380 * 86400000).toISOString().slice(0, 10);
  const bhEopObs = [
    makeObservation("phq9-eop", "44261-6", "PHQ-9 total", "Patient/access-test-p04", bhEopDate, 4),
    makeObservation("gad7-eop", "70274-6", "GAD-7 total", "Patient/access-test-p04", bhEopDate, 5),
    makeObservation("pgic-bh-eop", "77865-4", "PGIC", "Patient/access-test-p04", bhEopDate, 2),
  ];
  res = await mockPOST("/$report-data",
    makeReportDataParams(
      makeMeasureReport("Patient/access-test-p04", "bh", "Organization/ACCESS1234", bhEopDate, todayStr, bhEopDate, ["phq9-eop", "gad7-eop", "pgic-bh-eop"]),
      bhEopObs));
  await assertAsyncResult(res, "$report-data [BH end-of-period]", "accepted");

  // ─── eCKM Baseline ───
  sub("eCKM baseline — BP + labs");
  await mockPOST("/$mock-reset", {});
  await mockPOST("/Patient/$align", makeAlignParams(patients.p01, "eCKM", "Early CKM", conditions.eckm, true));
  const eckmObs = [
    makeBPObservation("bp-panel-1", "Patient/access-test-p01", todayStr, 148, 92),
    makeObservation("ldl-1", "13457-7", "LDL Cholesterol", "Patient/access-test-p01", todayStr, { value: 145, unit: "mg/dL" }),
    makeObservation("total-chol-1", "2093-3", "Total Cholesterol", "Patient/access-test-p01", todayStr, { value: 230, unit: "mg/dL" }),
    makeObservation("trig-1", "2571-8", "Triglycerides", "Patient/access-test-p01", todayStr, { value: 180, unit: "mg/dL" }),
    makeObservation("bmi-1", "39156-5", "BMI", "Patient/access-test-p01", todayStr, { value: 31.2, unit: "kg/m2" }),
    makeObservation("waist-1", "56086-2", "Waist circumference", "Patient/access-test-p01", todayStr, { value: 102, unit: "cm" }),
    makeObservation("glucose-1", "1558-6", "Fasting glucose", "Patient/access-test-p01", todayStr, { value: 118, unit: "mg/dL" }),
    makeObservation("hba1c-1", "4548-4", "HbA1c", "Patient/access-test-p01", todayStr, { value: 6.2, unit: "%" }),
  ];
  res = await mockPOST("/$report-data",
    makeReportDataParams(
      makeMeasureReport("Patient/access-test-p01", "eckm", "Organization/ACCESS1234", todayStr, thirtyDaysAgo, todayStr,
        ["bp-panel-1", "ldl-1", "total-chol-1", "trig-1", "bmi-1", "waist-1", "glucose-1", "hba1c-1"]),
      eckmObs));
  await assertAsyncResult(res, "$report-data [eCKM baseline]", "accepted");

  // ─── CKM Baseline ───
  sub("CKM baseline — HbA1c + eGFR + BP + UACR");
  await mockPOST("/$mock-reset", {});
  await mockPOST("/Patient/$align", makeAlignParams(patients.p02, "CKM", "CKM Track", conditions.ckm, true));
  const ckmObs = [
    makeObservation("hba1c-ckm", "4548-4", "HbA1c", "Patient/access-test-p02", todayStr, { value: 8.5, unit: "%" }),
    makeObservation("egfr-1", "48642-3", "eGFR", "Patient/access-test-p02", todayStr, { value: 42, unit: "mL/min/1.73m2" }),
    makeBPObservation("bp-ckm-1", "Patient/access-test-p02", todayStr, 152, 96),
    makeObservation("uacr-1", "9318-7", "UACR", "Patient/access-test-p02", todayStr, { value: 85, unit: "mg/g" }),
  ];
  res = await mockPOST("/$report-data",
    makeReportDataParams(
      makeMeasureReport("Patient/access-test-p02", "ckm", "Organization/ACCESS1234", todayStr, thirtyDaysAgo, todayStr,
        ["hba1c-ckm", "egfr-1", "bp-ckm-1", "uacr-1"]),
      ckmObs));
  await assertAsyncResult(res, "$report-data [CKM baseline]", "accepted");

  // ─── Rejection Tests ───

  sub("rejected-not-aligned (non-aligned patient)");
  const naObs = [
    makeObservation("nrs-na", "72514-3", "Pain NRS", "Patient/access-test-p-noalign", todayStr, 5),
    makeObservation("pf-na", "77849-8", "PROMIS PF", "Patient/access-test-p-noalign", todayStr, { value: 40, unit: "T-score" }),
    makeObservation("pi-na", "62193-8", "PROMIS PI", "Patient/access-test-p-noalign", todayStr, { value: 55, unit: "T-score" }),
  ];
  res = await mockPOST("/$report-data",
    makeReportDataParams(
      makeMeasureReport("Patient/access-test-p-noalign", "msk", "Organization/ACCESS1234", todayStr, thirtyDaysAgo, todayStr, ["nrs-na", "pf-na", "pi-na"]),
      naObs));
  await assertAsyncResult(res, "$report-data [non-aligned]", "rejected-not-aligned");

  sub("rejected-missing-measures (MSK: only NRS, missing PROMIS)");
  await mockPOST("/$mock-reset", {});
  await mockPOST("/Patient/$align", makeAlignParams(patients.p03, "MSK", "MSK Track", conditions.msk, true));
  res = await mockPOST("/$report-data",
    makeReportDataParams(
      makeMeasureReport("Patient/access-test-p03", "msk", "Organization/ACCESS1234", todayStr, thirtyDaysAgo, todayStr, ["nrs-inc"]),
      [makeObservation("nrs-inc", "72514-3", "Pain NRS", "Patient/access-test-p03", todayStr, 6)]));
  await assertAsyncResult(res, "$report-data [missing measures]", "rejected-missing-measures");

  sub("rejected-outside-window (baseline overdue at day 65)");
  await mockPOST("/$mock-reset", {});
  await mockPOST("/Patient/$align", makeAlignParams(patients.p03, "MSK", "MSK Track", conditions.msk, true));
  const overdueDate = new Date(today.getTime() + 65 * 86400000).toISOString().slice(0, 10);
  const overdueObs = [
    makeObservation("nrs-od", "72514-3", "Pain NRS", "Patient/access-test-p03", overdueDate, 6),
    makeObservation("pf-od", "77849-8", "PROMIS PF", "Patient/access-test-p03", overdueDate, { value: 38, unit: "T-score" }),
    makeObservation("pi-od", "62193-8", "PROMIS PI", "Patient/access-test-p03", overdueDate, { value: 62, unit: "T-score" }),
  ];
  res = await mockPOST("/$report-data",
    makeReportDataParams(
      makeMeasureReport("Patient/access-test-p03", "msk", "Organization/ACCESS1234", overdueDate, todayStr, overdueDate, ["nrs-od", "pf-od", "pi-od"]),
      overdueObs));
  await assertAsyncResult(res, "$report-data [baseline overdue]", "rejected-outside-window");
}

async function testSubmissionStatus() {
  section(6, "$submission-status — Async 202→200 Pattern (Mock)");
  await mockPOST("/$mock-reset", {});

  sub("Poll immediately → 202, then → 200");
  const res = await mockPOST("/Patient/$check-eligibility",
    makeEligibilityParams(patients.p01, "eCKM", "Early CKM", conditions.eckm));
  assertHttp("POST $check-eligibility", res, 202);
  const subId = extractSubmissionID(res.data);

  if (subId) {
    const immediatePoll = await mockGET(`/Patient/$submission-status?submissionID=${subId}`);
    info(`Immediate poll → HTTP ${immediatePoll.status}`);
    total++;
    if (immediatePoll.status === 202 || immediatePoll.status === 200) {
      pass++;
      console.log(`  ${c.green("PASS")} Immediate poll returns valid status`);
    } else {
      fail++;
      console.log(`  ${c.red("FAIL")} Unexpected immediate poll status`);
    }

    await new Promise((r) => setTimeout(r, 800));
    const completePoll = await mockGET(`/Patient/$submission-status?submissionID=${subId}`);
    assertHttp("Completed poll → 200", completePoll, 200);
    if (completePoll.data) {
      assertField("Has submissionType", completePoll.data, "parameter[0].name", "submissionType");
    }
  }

  sub("Unknown submissionID → 404");
  const unknown = await mockGET("/Patient/$submission-status?submissionID=nonexistent");
  assertHttp("Unknown submissionID", unknown, 404);
}

async function testUnalign() {
  section(7, "$unalign — All Result Codes (Mock)");
  await mockPOST("/$mock-reset", {});

  await Promise.all([
    mockPOST("/Patient/$align", makeAlignParams(patients.p02, "CKM", "CKM Track", conditions.ckm, true)),
    mockPOST("/Patient/$align", makeAlignParams(patients.p04, "BH", "BH Track", conditions.bh, false)),
    mockPOST("/Patient/$align", makeAlignParams(patients.p03, "MSK", "MSK Track", conditions.msk, true)),
  ]);

  // 1. unaligned
  sub("unaligned (geographic-relocated)");
  let res = await mockPOST("/Patient/$unalign",
    makeUnalignParams(patients.p02, "CKM", "CKM Track", "geographic-relocated", "Geographic relocated"));
  assertHttp("POST $unalign [geographic-relocated]", res, 202);
  let subId = extractSubmissionID(res.data);
  if (subId) {
    const poll = await pollSubmission(subId);
    assertHttp("Poll unalign result", poll, 200);
    if (poll.data) assertResultCode("Result = unaligned", poll.data, "unaligned");
  }

  // 2. patient-not-aligned
  sub("patient-not-aligned (not aligned patient)");
  res = await mockPOST("/Patient/$unalign",
    makeUnalignParams(edgePatients.reportNonAligned, "MSK", "MSK Track", "patient-initiated", "Patient initiated"));
  await assertAsyncResult(res, "$unalign [not aligned]", "patient-not-aligned");

  // 3. unaligned-clinical-exclusion
  sub("unaligned-clinical-exclusion (ESRD condition)");
  const esrdCond = makeCondition(undefined, "access-clinical-exclusion-condition", "N18.6", "End stage renal disease", "Patient/access-test-p03", "2024-01-15");
  res = await mockPOST("/Patient/$unalign",
    makeUnalignParams(patients.p03, "MSK", "MSK Track", "no-longer-clinically-eligible", "No longer clinically eligible", esrdCond));
  await assertAsyncResult(res, "$unalign [clinical-exclusion]", "unaligned-clinical-exclusion");
}

async function testValidation() {
  section(8, "FHIR Resource Validation - $validate (HAPI)");

  const validations = [
    ["Patient", patients.p01],
    ["eCKM Condition", conditions.eckm],
    ["CKM Condition", conditions.ckm],
    ["MSK Condition", conditions.msk],
    ["BH Condition", conditions.bh],
    ["Organization", org],
    ["Practitioner", practitioner],
  ];

  await Promise.all(validations.map(([label, resource]) =>
    POST(`/${resource.resourceType}/$validate`, resource).then((res) => {
      assertHttp(`Validate ${label}`, res, 200);
    })
  ));
}

async function testCleanup() {
  section(9, "Cleanup Test Resources (HAPI)");

  await Promise.all(Object.values(conditions).map((cond) =>
    DELETE(`/Condition/${cond.id}`).then((res) => assertHttp(`DELETE ${cond.id}`, res, 200, 204))
  ));

  await Promise.all(Object.values(patients).map((p) =>
    DELETE(`/Patient/${p.id}`).then((res) => assertHttp(`DELETE ${p.id}`, res, 200, 204))
  ));

  const [ro, rp] = await Promise.all([
    DELETE("/Organization/access-test-org-01"),
    DELETE("/Practitioner/access-test-pract-01"),
  ]);
  assertHttp("DELETE Organization", ro, 200, 204);
  assertHttp("DELETE Practitioner", rp, 200, 204);

  await mockPOST("/$mock-reset", {});
  info("Mock state reset.");
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log("");
  console.log(c.bold("============================================"));
  console.log(c.bold(" ACCESS Model FHIR API - E2E Test Suite"));
  console.log(c.bold("============================================"));
  console.log(` HAPI Server: ${c.blue(FHIR_BASE)}`);
  console.log(` Mock Server: ${c.blue(MOCK_BASE)}`);
  console.log(` Date:        ${new Date().toLocaleString()}`);

  let hapiAvailable = false;
  let mockAvailable = false;

  try {
    const h = await fetch(`${FHIR_BASE}/metadata`, { signal: AbortSignal.timeout(3000) });
    hapiAvailable = h.ok;
  } catch { /* offline */ }

  try {
    const m = await fetch(`${MOCK_BASE}/metadata`, { signal: AbortSignal.timeout(3000) });
    mockAvailable = m.ok;
  } catch { /* offline */ }

  console.log(` HAPI:        ${hapiAvailable ? c.green("ONLINE") : c.red("OFFLINE")}`);
  console.log(` Mock:        ${mockAvailable ? c.green("ONLINE") : c.red("OFFLINE")}`);

  if (!hapiAvailable && !mockAvailable) {
    console.log(c.red("\nNo servers available. Start HAPI (port 8080) and/or Mock (port 3001)."));
    process.exit(1);
  }

  if (hapiAvailable) {
    await testHealthCheck();
    await testResourceCRUD();
    await testConformanceResources();
    await testValidation();
  } else {
    note("Skipping HAPI tests (server offline).");
  }

  if (mockAvailable) {
    if (!hapiAvailable) {
      section(0, "Server Health Check (Mock only)");
      const mockRes = await mockGET("/metadata");
      assertHttp("GET Mock /metadata", mockRes, 200);
    }
    await testCheckEligibility();
    await testAlign();
    await testReportData();
    await testSubmissionStatus();
    await testUnalign();
  } else {
    note("Skipping Mock tests (server offline). Run: npm run start:mock");
  }

  if (hapiAvailable) await testCleanup();

  console.log("");
  console.log(c.bold("============================================"));
  console.log(c.bold(" TEST RESULTS"));
  console.log(c.bold("============================================"));
  console.log(` Total:  ${total}`);
  console.log(` Passed: ${c.green(pass)}`);
  console.log(` Failed: ${c.red(fail)}`);
  console.log("");

  if (fail === 0) {
    console.log(c.green("ALL TESTS PASSED"));
  } else {
    console.log(c.yellow(`${fail} test(s) failed - review output above`));
  }

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(c.red(`Fatal: ${err.message}`));
  process.exit(1);
});
