#!/usr/bin/env node
// =============================================================================
// ACCESS Model Mock FHIR Server
//
// Educational mock implementing the 5 ACCESS Model custom operations:
//   1. POST /fhir/Patient/$check-eligibility  (Screen)
//   2. POST /fhir/Patient/$align              (Enroll)
//   3. POST /fhir/$report-data                (Report)
//   4. POST /fhir/Patient/$unalign            (Manage/Exit)
//   5. GET  /fhir/Patient/$submission-status   (Poll)
//
// All payloads conform to the published IG + RFA specifications.
// $report-data is based on RFA, Da Vinci DEQM, and PCO IG references.
// =============================================================================

import express from "express";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const PORT = parseInt(process.env.MOCK_PORT || "3001", 10);
const LOCK_IN_DAYS = parseInt(process.env.LOCK_IN_DAYS || "90", 10);
const BASELINE_WINDOW_DAYS = parseInt(process.env.BASELINE_WINDOW_DAYS || "60", 10);
const ASYNC_DELAY_MS = parseInt(process.env.ASYNC_DELAY_MS || "500", 10);

// =============================================================================
// Constants
// =============================================================================

const ACCESS_CS_BASE = "https://dsacms.github.io/cmmi-access-model/CodeSystem";
const MBI_SYSTEM = "http://terminology.hl7.org/NamingSystem/cmsMBI";

const RESULT_SYSTEMS = {
  eligibility: `${ACCESS_CS_BASE}/ACCESSEligibilityResultCS`,
  alignment: `${ACCESS_CS_BASE}/ACCESSAlignmentResultCS`,
  unalignment: `${ACCESS_CS_BASE}/ACCESSUnalignmentResultCS`,
  "report-data": `${ACCESS_CS_BASE}/ACCESSReportDataResultCS`,
};

const TRACK_NORMALIZE = { ECKM: "eCKM", CKM: "CKM", MSK: "MSK", BH: "BH" };

// =============================================================================
// In-Memory State
// =============================================================================

// Map<"mbi:track" → { participantID, alignedAt, status }>
const alignments = new Map();

// Map<submissionID → { type, status, result, createdAt }>
const submissions = new Map();

// Map<"mbi:track" → [{ reportType, submittedAt, measureReport, resources }]>
const dataReports = new Map();

// Map<patientId → mbi> — reverse lookup for $report-data
const patientIdToMbi = new Map();

let submissionCounter = 0;

// =============================================================================
// Logging
// =============================================================================

const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function log(operation, message) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`${c.cyan(`[${ts}]`)} ${c.bold(`[${operation}]`)} ${message}`);
}

// =============================================================================
// Helpers
// =============================================================================

function isControlGroup(mbi, track) {
  const hash = createHash("sha256").update(`${mbi}:${track}`).digest();
  return hash[0] % 5 === 0;
}

function extractMBI(patient) {
  if (!patient?.identifier) return null;
  const mbiIdent = patient.identifier.find((id) => id.system === MBI_SYSTEM);
  return mbiIdent ? mbiIdent.value : null;
}

function extractParamValue(parameters, name) {
  const p = parameters?.parameter?.find((x) => x.name === name);
  if (!p) return undefined;
  if (p.resource) return p.resource;
  if (p.valueBoolean !== undefined) return p.valueBoolean;
  if (p.valueString !== undefined) return p.valueString;
  if (p.valueIdentifier) return p.valueIdentifier.value;
  if (p.valueCodeableConcept) return p.valueCodeableConcept.coding?.[0]?.code;
  return undefined;
}

function extractResource(parameters, name) {
  return parameters?.parameter?.find((x) => x.name === name)?.resource ?? null;
}

function extractAllResources(parameters, name) {
  if (!parameters?.parameter) return [];
  return parameters.parameter
    .filter((x) => x.name === name)
    .map((p) => p.resource)
    .filter(Boolean);
}

function getTrackCode(params) {
  const trackParam = params?.parameter?.find((x) => x.name === "track");
  return trackParam?.valueCodeableConcept?.coding?.[0]?.code ?? null;
}

function newSubmissionID() {
  return `sub-${++submissionCounter}-${Date.now()}`;
}

function daysBetween(d1, d2) {
  return Math.floor((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
}

// Track-specific ICD-10 prefix validation
const TRACK_ICD10_PREFIXES = {
  eCKM: ["I10", "I11", "I12", "I13", "I15", "I25", "I50", "E08", "E09", "E10", "E11", "E13", "E66", "E78", "N18"],
  CKM: ["N18", "E08", "E09", "E10", "E11", "E13", "I10", "I12", "I13", "I15"],
  MSK: ["M15", "M16", "M17", "M47", "M50", "M51", "M54", "M75", "M79", "G89"],
  BH: ["F20", "F25", "F31", "F32", "F33", "F34", "F40", "F41", "F42", "F43", "F90"],
};

const EXCLUSION_CODES = ["N18.6", "Z99.2", "Z94.0"];

function icd10MatchesTrack(icd10, track) {
  const prefixes = TRACK_ICD10_PREFIXES[track];
  if (!prefixes) return false;
  return prefixes.some((prefix) => icd10.startsWith(prefix));
}

function hasExclusion(conditions) {
  return conditions.some((cond) => {
    const code = cond?.code?.coding?.[0]?.code;
    return code && EXCLUSION_CODES.some((ex) => code.startsWith(ex));
  });
}

function checkIcd10Match(conditions, track) {
  return conditions.every((cond) => {
    const code = cond?.code?.coding?.[0]?.code;
    return code && icd10MatchesTrack(code, track);
  });
}

// =============================================================================
// Track-Specific Measure Requirements
// =============================================================================

const TRACK_REQUIRED_LOINCS = {
  eCKM: {
    baseline: ["85354-9", "13457-7", "2093-3", "2571-8", "39156-5", "56086-2", "1558-6", "4548-4"],
    quarterly: ["85354-9"],
    "end-of-period": ["85354-9", "13457-7", "2093-3", "2571-8", "39156-5", "56086-2", "1558-6", "4548-4"],
  },
  CKM: {
    baseline: ["4548-4", "48642-3", "85354-9", "9318-7"],
    quarterly: ["85354-9", "48642-3"],
    "end-of-period": ["4548-4", "48642-3", "85354-9", "9318-7"],
  },
  MSK: {
    baseline: ["72514-3", "77849-8", "62193-8"],
    quarterly: ["72514-3", "77849-8", "62193-8"],
    "end-of-period": ["72514-3", "77849-8", "62193-8", "77865-4"],
  },
  BH: {
    baseline: ["44261-6", "70274-6"],
    quarterly: ["44261-6", "70274-6"],
    "end-of-period": ["44261-6", "70274-6", "77865-4"],
  },
};

const MSK_ALTERNATIVE_LOINCS = {
  "77849-8": ["71934-4", "72100-1", "71933-6", "82324-5", "82323-7"],
  "62193-8": ["71934-4", "72100-1", "71933-6", "82324-5", "82323-7"],
};

// =============================================================================
// OAP Target Evaluation
// =============================================================================

// Higher-order evaluator factories to eliminate duplication
function improvementEval(threshold) {
  return (baseline, current) => {
    const bVal = extractNumericValue(baseline);
    const cVal = extractNumericValue(current);
    if (bVal == null || cVal == null) return null;
    return (cVal - bVal) >= threshold;
  };
}

function reductionEval(threshold) {
  return (baseline, current) => {
    const bVal = extractNumericValue(baseline);
    const cVal = extractNumericValue(current);
    if (bVal == null || cVal == null) return null;
    return (bVal - cVal) >= threshold;
  };
}

function reductionOrBelowEval(reductionThreshold, absoluteTarget) {
  return (baseline, current) => {
    const bVal = extractNumericValue(baseline);
    const cVal = extractNumericValue(current);
    if (bVal == null || cVal == null) return null;
    return (bVal - cVal >= reductionThreshold) || cVal < absoluteTarget;
  };
}

const OAP_TARGETS = {
  eCKM: {
    "85354-9": (baseline, current) => {
      const bpBase = extractSystolic(baseline);
      const bpCurr = extractSystolic(current);
      if (bpBase == null || bpCurr == null) return null;
      return (bpBase - bpCurr >= 10) || bpCurr < 130;
    },
  },
  CKM: {
    "4548-4": (baseline, current) => {
      const bVal = extractNumericValue(baseline);
      const cVal = extractNumericValue(current);
      if (bVal == null || cVal == null) return null;
      return cVal < bVal || cVal < 7.0;
    },
  },
  MSK: {
    "72514-3": (baseline, current) => {
      const bVal = extractNumericValue(baseline);
      const cVal = extractNumericValue(current);
      if (bVal == null || cVal == null) return null;
      return (cVal - bVal) <= 2; // no more than 2-point increase
    },
    "77849-8": improvementEval(2),
    "82324-5": improvementEval(10),
    "82323-7": improvementEval(10),
    "71934-4": reductionEval(8),   // ODI: lower=better
    "72100-1": reductionEval(8),   // NDI: lower=better
    "71933-6": reductionEval(10),  // QuickDASH: lower=better
  },
  BH: {
    "44261-6": reductionOrBelowEval(5, 5), // PHQ-9
    "70274-6": reductionOrBelowEval(4, 5), // GAD-7
  },
};

function extractSystolic(obs) {
  if (!obs) return null;
  if (obs.component) {
    const sys = obs.component.find((comp) =>
      comp.code?.coding?.some((c) => c.code === "8480-6")
    );
    if (sys) return sys.valueQuantity?.value ?? null;
  }
  return obs.valueQuantity?.value ?? null;
}

function extractNumericValue(obs) {
  if (!obs) return null;
  if (obs.valueInteger !== undefined) return obs.valueInteger;
  if (obs.valueQuantity?.value !== undefined) return obs.valueQuantity.value;
  return null;
}

function evaluateOAPTargets(track, baselineResources, currentResources) {
  const targets = OAP_TARGETS[track];
  if (!targets) return { evaluated: false };

  const results = {};
  let metCount = 0;
  let totalCount = 0;

  for (const [loinc, evalFn] of Object.entries(targets)) {
    const baseObs = findObsByLOINC(baselineResources, loinc);
    const currObs = findObsByLOINC(currentResources, loinc);
    if (baseObs && currObs) {
      const met = evalFn(baseObs, currObs);
      results[loinc] = met;
      totalCount++;
      if (met) metCount++;
    }
  }

  return {
    evaluated: true,
    results,
    metCount,
    totalCount,
    allMet: totalCount > 0 && metCount === totalCount,
    oatThresholdMet: totalCount > 0 && metCount / totalCount >= 0.5,
  };
}

function findObsByLOINC(resources, loinc) {
  if (!resources) return null;
  return resources.find((r) => {
    if (r.resourceType !== "Observation") return false;
    return r.code?.coding?.some((c) => c.code === loinc);
  });
}

// =============================================================================
// FHIR Response Builders
// =============================================================================

function operationOutcome(severity, code, diagnostics) {
  return {
    resourceType: "OperationOutcome",
    issue: [{ severity, code, diagnostics }],
  };
}

function makeResultParams(systemKey, resultCode, diagnosticsMsg) {
  const params = [
    {
      name: "result",
      valueCodeableConcept: {
        coding: [{ system: RESULT_SYSTEMS[systemKey], code: resultCode }],
      },
    },
  ];
  if (diagnosticsMsg) {
    params.push({
      name: "operationOutcome",
      resource: operationOutcome("information", "informational", diagnosticsMsg),
    });
  }
  return { resourceType: "Parameters", parameter: params };
}

function submissionStatusResult(type, result) {
  return {
    resourceType: "Parameters",
    parameter: [
      { name: "submissionType", valueString: type },
      { name: "result", resource: result },
    ],
  };
}

// =============================================================================
// Async Submission Helper
// =============================================================================

function sendAsyncResult(res, type, result, message) {
  const subId = newSubmissionID();
  submissions.set(subId, { type, status: "pending", result, createdAt: Date.now() });

  setTimeout(() => {
    const sub = submissions.get(subId);
    if (sub) sub.status = "complete";
  }, ASYNC_DELAY_MS);

  log("HTTP", `→ 202 Accepted (submissionID=${subId})`);
  res.set("Content-Location", `/fhir/Patient/$submission-status?submissionID=${subId}`);
  res.status(202).json(operationOutcome("information", "informational", `${message} submissionID=${subId}`));
}

// =============================================================================
// Operation 1: $check-eligibility
// =============================================================================

function processCheckEligibility(params) {
  const patient = extractResource(params, "patient");
  const track = getTrackCode(params);
  const conditions = extractAllResources(params, "condition");
  const mbi = extractMBI(patient);

  log("$check-eligibility", `Patient MBI=${mbi || "NONE"} Track=${track}`);

  // 1. No MBI
  if (!mbi) {
    log("$check-eligibility", `${c.yellow("→ not-eligible-not-medicare")} (no MBI)`);
    return makeResultParams("eligibility", "not-eligible-not-medicare");
  }

  // 2. Exclusion condition (ESRD, etc.)
  if (conditions.length > 0 && hasExclusion(conditions)) {
    log("$check-eligibility", `${c.yellow("→ not-eligible-services")} (exclusion condition found)`);
    return makeResultParams("eligibility", "not-eligible-services");
  }

  // 3. Control group
  const key = `${mbi}:${track}`;
  if (isControlGroup(mbi, track)) {
    log("$check-eligibility", `${c.yellow("→ not-eligible-control-group")} (hash-based)`);
    return makeResultParams("eligibility", "not-eligible-control-group");
  }

  // 4. Already aligned to different participant
  if (alignments.has(key)) {
    const existing = alignments.get(key);
    const participantID = extractParamValue(params, "participantID");
    if (existing.participantID !== participantID && existing.status === "aligned") {
      log("$check-eligibility", `${c.yellow("→ not-eligible-already-aligned")} (aligned to ${existing.participantID})`);
      return makeResultParams("eligibility", "not-eligible-already-aligned");
    }
  }

  // 5. ICD-10 doesn't match track
  if (conditions.length > 0 && !checkIcd10Match(conditions, track)) {
    log("$check-eligibility", `${c.yellow("→ not-eligible-diagnoses")} (ICD-10 mismatch for ${track})`);
    return makeResultParams("eligibility", "not-eligible-diagnoses");
  }

  // 6. No condition → pending diagnosis
  if (conditions.length === 0) {
    log("$check-eligibility", `${c.yellow("→ eligible-pending-diagnosis")} (no conditions submitted)`);
    return makeResultParams("eligibility", "eligible-pending-diagnosis");
  }

  // 7. Already aligned same track, check for switch opportunity
  if (alignments.has(key) && alignments.get(key).status === "aligned") {
    log("$check-eligibility", `${c.green("→ eligible-switch-participants")} (already aligned, switch possible)`);
    return makeResultParams("eligibility", "eligible-switch-participants");
  }

  // 8. All clear
  log("$check-eligibility", `${c.green("→ eligible")}`);
  return makeResultParams("eligibility", "eligible");
}

// =============================================================================
// Operation 2: $align
// =============================================================================

function storeAlignment(key, participantID, patient, mbi) {
  alignments.set(key, {
    participantID,
    alignedAt: new Date().toISOString(),
    status: "aligned",
  });
  if (patient?.id) patientIdToMbi.set(patient.id, mbi);
}

function processAlign(params) {
  const patient = extractResource(params, "patient");
  const track = getTrackCode(params);
  const conditions = extractAllResources(params, "condition");
  const mbi = extractMBI(patient);
  const participantID = extractParamValue(params, "participantID");
  const switchConsent = extractParamValue(params, "switchConsentAttestation");

  log("$align", `Patient MBI=${mbi || "NONE"} Track=${track} Participant=${participantID}`);

  if (!mbi) {
    log("$align", `${c.red("→ not-aligned-not-medicare")}`);
    return makeResultParams("alignment", "not-aligned-not-medicare");
  }

  const key = `${mbi}:${track}`;

  if (isControlGroup(mbi, track)) {
    log("$align", `${c.red("→ not-aligned-control-group")}`);
    return makeResultParams("alignment", "not-aligned-control-group");
  }

  if (conditions.length > 0 && hasExclusion(conditions)) {
    log("$align", `${c.red("→ not-aligned-services")} (exclusion condition)`);
    return makeResultParams("alignment", "not-aligned-services");
  }

  if (conditions.length > 0 && !checkIcd10Match(conditions, track)) {
    log("$align", `${c.red("→ not-aligned-diagnoses")} (ICD-10 mismatch)`);
    return makeResultParams("alignment", "not-aligned-diagnoses");
  }

  if (alignments.has(key)) {
    const existing = alignments.get(key);
    if (existing.status === "aligned") {
      if (existing.participantID === participantID) {
        log("$align", `${c.yellow("→ not-aligned-already-aligned")} (same participant)`);
        return makeResultParams("alignment", "not-aligned-already-aligned");
      }

      const daysSinceAlign = daysBetween(new Date(existing.alignedAt), new Date());
      if (daysSinceAlign <= LOCK_IN_DAYS) {
        log("$align", `${c.yellow("→ not-aligned-already-aligned")} (within ${LOCK_IN_DAYS}-day lock-in, ${daysSinceAlign} days elapsed)`);
        return makeResultParams("alignment", "not-aligned-already-aligned");
      }

      if (switchConsent === true) {
        storeAlignment(key, participantID, patient, mbi);
        log("$align", `${c.green("→ aligned-switch-approved")} (switched from ${existing.participantID})`);
        return makeResultParams("alignment", "aligned-switch-approved");
      }
    }
  }

  storeAlignment(key, participantID, patient, mbi);
  log("$align", `${c.green("→ aligned")} (stored in alignment registry)`);
  return makeResultParams("alignment", "aligned");
}

// =============================================================================
// Operation 3: $report-data
// =============================================================================

function processReportData(params) {
  const measureReport = extractResource(params, "measureReport");
  const resources = extractAllResources(params, "resource");

  if (!measureReport || measureReport.resourceType !== "MeasureReport") {
    log("$report-data", `${c.red("→ rejected")} (missing MeasureReport)`);
    return { error: operationOutcome("error", "required", "Missing required MeasureReport parameter") };
  }

  const subjectRef = measureReport.subject?.reference;
  const patientId = subjectRef?.replace("Patient/", "");
  log("$report-data", `Subject=${subjectRef} MeasureURL=${measureReport.measure}`);

  // Extract and normalize track from measure URL
  const trackMatch = (measureReport.measure || "").match(/access-(\w+)-/);
  const normalizedTrack = trackMatch ? TRACK_NORMALIZE[trackMatch[1].toUpperCase()] ?? null : null;

  if (!normalizedTrack) {
    log("$report-data", `${c.red("→ rejected")} (cannot determine track from measure URL)`);
    return { error: operationOutcome("error", "value", "Cannot determine track from MeasureReport.measure URL") };
  }

  // Look up MBI from patient ID, then find alignment
  const mbi = patientIdToMbi.get(patientId) || patientId;
  let alignmentKey = `${mbi}:${normalizedTrack}`;

  if (!alignments.has(alignmentKey)) {
    // Fallback: iterate alignments for match
    alignmentKey = null;
    for (const [key] of alignments.entries()) {
      const [keyMbi, keyTrack] = key.split(":");
      if (keyTrack === normalizedTrack && (patientId === keyMbi || mbi === keyMbi)) {
        alignmentKey = key;
        break;
      }
    }
  }

  if (!alignmentKey || !alignments.has(alignmentKey)) {
    log("$report-data", `${c.red("→ rejected-not-aligned")} (no alignment found for ${patientId}:${normalizedTrack})`);
    return { result: makeResultParams("report-data", "rejected-not-aligned") };
  }

  const alignment = alignments.get(alignmentKey);
  if (alignment.status !== "aligned") {
    log("$report-data", `${c.red("→ rejected-not-aligned")} (status=${alignment.status})`);
    return { result: makeResultParams("report-data", "rejected-not-aligned") };
  }

  // Determine report type from timing
  const alignedAt = new Date(alignment.alignedAt);
  const reportDate = measureReport.date ? new Date(measureReport.date) : new Date();
  const daysSinceAlignment = daysBetween(alignedAt, reportDate);
  const existingReports = dataReports.get(alignmentKey) || [];

  let reportType;
  if (existingReports.length === 0) {
    if (daysSinceAlignment > BASELINE_WINDOW_DAYS) {
      log("$report-data", `${c.yellow("⚠ Baseline overdue")} (${daysSinceAlignment} days since alignment, window=${BASELINE_WINDOW_DAYS})`);
      alignment.status = "auto-unaligned-baseline-overdue";
      log("$report-data", `${c.red("→ auto-unalign triggered")} (baseline overdue)`);
      return {
        result: makeResultParams("report-data", "rejected-outside-window",
          `Baseline overdue: ${daysSinceAlignment} days since alignment exceeds ${BASELINE_WINDOW_DAYS}-day window. Patient auto-unaligned.`),
      };
    }
    reportType = "baseline";
  } else {
    const lastReport = existingReports[existingReports.length - 1];
    const daysSinceLast = daysBetween(new Date(lastReport.submittedAt), reportDate);

    if (daysSinceAlignment >= 365) {
      reportType = "end-of-period";
    } else if (daysSinceLast >= 70 && daysSinceLast <= 110) {
      reportType = "quarterly";
    } else if (daysSinceAlignment >= 185 && (normalizedTrack === "BH" || normalizedTrack === "MSK")) {
      reportType = "end-of-period"; // early success window
    } else if (daysSinceLast < 70) {
      log("$report-data", `${c.yellow("→ rejected-outside-window")} (only ${daysSinceLast} days since last report, need 70-110)`);
      return {
        result: makeResultParams("report-data", "rejected-outside-window",
          `Report submitted ${daysSinceLast} days since last report. Quarterly window is 70-110 days.`),
      };
    } else {
      reportType = "quarterly";
    }
  }

  log("$report-data", `Report type: ${c.bold(reportType)} (${daysSinceAlignment} days since alignment)`);

  // Validate required resources per track
  const requiredLoincs = TRACK_REQUIRED_LOINCS[normalizedTrack]?.[reportType];
  if (requiredLoincs) {
    const submittedLoincs = new Set();
    for (const res of resources) {
      if (res.resourceType === "Observation") {
        for (const coding of (res.code?.coding || [])) {
          submittedLoincs.add(coding.code);
        }
      }
    }

    const missing = [];
    for (const req of requiredLoincs) {
      if (submittedLoincs.has(req)) continue;
      if (normalizedTrack === "MSK" && MSK_ALTERNATIVE_LOINCS[req]?.some((alt) => submittedLoincs.has(alt))) continue;
      missing.push(req);
    }

    if (missing.length > 0) {
      log("$report-data", `${c.red("→ rejected-missing-measures")} (missing LOINCs: ${missing.join(", ")})`);
      return {
        result: makeResultParams("report-data", "rejected-missing-measures",
          `Missing required measures for ${normalizedTrack} ${reportType}: ${missing.join(", ")}`),
      };
    }
  }

  // Store report
  if (!dataReports.has(alignmentKey)) dataReports.set(alignmentKey, []);
  dataReports.get(alignmentKey).push({
    reportType,
    submittedAt: reportDate.toISOString(),
    measureReport,
    resources,
  });

  // Evaluate OAP targets if end-of-period
  let oapMessage = null;
  if (reportType === "end-of-period" && existingReports.length > 0) {
    const baselineReport = existingReports.find((r) => r.reportType === "baseline");
    if (baselineReport) {
      const oap = evaluateOAPTargets(normalizedTrack, baselineReport.resources, resources);
      if (oap.evaluated) {
        const resultStr = oap.allMet ? c.green("ALL TARGETS MET") : `${oap.metCount}/${oap.totalCount} targets met`;
        log("$report-data", `${c.bold("OAP Evaluation:")} ${resultStr}`);
        for (const [loinc, met] of Object.entries(oap.results)) {
          log("$report-data", `  LOINC ${loinc}: ${met ? c.green("MET") : c.red("NOT MET")}`);
        }
        log("$report-data", `OAT threshold (≥50%): ${oap.oatThresholdMet ? c.green("PASSED") : c.red("NOT PASSED")}`);
        oapMessage = `OAP evaluation: ${oap.metCount}/${oap.totalCount} targets met. OAT threshold ${oap.oatThresholdMet ? "PASSED" : "NOT PASSED"}.`;
      }
    }
  }

  log("$report-data", `${c.green("→ accepted")} (${reportType} report stored, ${resources.length} resources)`);
  return { result: makeResultParams("report-data", "accepted", oapMessage) };
}

// =============================================================================
// Operation 4: $unalign
// =============================================================================

function processUnalign(params) {
  const patient = extractResource(params, "patient");
  const track = getTrackCode(params);
  const mbi = extractMBI(patient);
  const reasonCode = extractParamValue(params, "reason");

  log("$unalign", `Patient MBI=${mbi || "NONE"} Track=${track} Reason=${reasonCode}`);

  if (!mbi) {
    log("$unalign", `${c.red("→ patient-not-aligned")} (no MBI)`);
    return makeResultParams("unalignment", "patient-not-aligned");
  }

  const key = `${mbi}:${track}`;
  if (!alignments.has(key) || alignments.get(key).status !== "aligned") {
    log("$unalign", `${c.red("→ patient-not-aligned")} (no active alignment)`);
    return makeResultParams("unalignment", "patient-not-aligned");
  }

  const conditionResources = extractAllResources(params, "condition");
  if (reasonCode === "no-longer-clinically-eligible" && conditionResources.length > 0 && hasExclusion(conditionResources)) {
    alignments.get(key).status = "unaligned";
    log("$unalign", `${c.green("→ unaligned-clinical-exclusion")} (exclusion condition confirmed)`);
    return makeResultParams("unalignment", "unaligned-clinical-exclusion");
  }

  alignments.get(key).status = "unaligned";
  log("$unalign", `${c.green("→ unaligned")} (reason: ${reasonCode})`);
  return makeResultParams("unalignment", "unaligned");
}

// =============================================================================
// Express App
// =============================================================================

const app = express();
app.use(express.json({ type: ["application/json", "application/fhir+json"], limit: "5mb" }));

const __dirname = dirname(fileURLToPath(import.meta.url));
app.use(express.static(join(__dirname, "..", "docs")));
app.use((_req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, Accept");
  next();
});
app.get("/", (_req, res) => res.redirect("/index.html"));

app.get("/fhir/metadata", (_req, res) => {
  res.json({
    resourceType: "CapabilityStatement",
    status: "active",
    fhirVersion: "4.0.1",
    kind: "instance",
    format: ["application/fhir+json"],
    rest: [{
      mode: "server",
      operation: [
        { name: "check-eligibility", definition: "OperationDefinition/CheckEligibility" },
        { name: "align", definition: "OperationDefinition/Align" },
        { name: "unalign", definition: "OperationDefinition/Unalign" },
        { name: "report-data", definition: "OperationDefinition/ReportData" },
        { name: "submission-status", definition: "OperationDefinition/SubmissionStatus" },
      ],
    }],
  });
});

app.post("/fhir/Patient/\\$check-eligibility", (req, res) => {
  log("HTTP", `POST /fhir/Patient/$check-eligibility`);
  sendAsyncResult(res, "eligibility", processCheckEligibility(req.body), "Request accepted.");
});

app.post("/fhir/Patient/\\$align", (req, res) => {
  log("HTTP", `POST /fhir/Patient/$align`);
  sendAsyncResult(res, "alignment", processAlign(req.body), "Request accepted.");
});

app.post("/fhir/\\$report-data", (req, res) => {
  log("HTTP", `POST /fhir/$report-data`);
  const outcome = processReportData(req.body);
  if (outcome.error) {
    res.status(400).json(outcome.error);
    return;
  }
  sendAsyncResult(res, "report-data", outcome.result, "Data report accepted.");
});

app.post("/fhir/Patient/\\$unalign", (req, res) => {
  log("HTTP", `POST /fhir/Patient/$unalign`);
  sendAsyncResult(res, "unalignment", processUnalign(req.body), "Request accepted.");
});

app.get("/fhir/Patient/\\$submission-status", (req, res) => {
  const subId = req.query.submissionID;
  log("HTTP", `GET /fhir/Patient/$submission-status?submissionID=${subId}`);

  if (!subId || !submissions.has(subId)) {
    log("$submission-status", `${c.red("→ not-found")}`);
    res.status(404).json(operationOutcome("error", "not-found", `Submission ${subId} not found`));
    return;
  }

  const sub = submissions.get(subId);
  if (sub.status === "pending") {
    log("$submission-status", `${c.yellow("→ 202 pending")}`);
    res.status(202).json(operationOutcome("information", "informational", "Processing in progress. Please retry."));
    return;
  }

  log("$submission-status", `${c.green("→ 200 complete")} (type=${sub.type})`);
  res.status(200).json(submissionStatusResult(sub.type, sub.result));
});

app.get("/fhir/\\$mock-state", (_req, res) => {
  res.json({
    alignments: Object.fromEntries(alignments),
    submissions: Object.fromEntries(
      [...submissions.entries()].map(([k, v]) => [k, { type: v.type, status: v.status, createdAt: v.createdAt }])
    ),
    dataReports: Object.fromEntries(
      [...dataReports.entries()].map(([k, v]) => [k, v.map((r) => ({ reportType: r.reportType, submittedAt: r.submittedAt }))])
    ),
  });
});

app.post("/fhir/\\$mock-reset", (_req, res) => {
  alignments.clear();
  submissions.clear();
  dataReports.clear();
  patientIdToMbi.clear();
  submissionCounter = 0;
  log("RESET", "All in-memory state cleared");
  res.status(200).json(operationOutcome("information", "informational", "Mock state reset"));
});

// =============================================================================
// Start Server
// =============================================================================

app.listen(PORT, () => {
  console.log("");
  console.log(c.bold("============================================"));
  console.log(c.bold(" ACCESS Model Mock FHIR Server"));
  console.log(c.bold("============================================"));
  console.log(` ${c.green("Listening on:")} http://localhost:${PORT}/fhir`);
  console.log(` ${c.blue("Operations:")}`);
  console.log(`   POST /fhir/Patient/$check-eligibility`);
  console.log(`   POST /fhir/Patient/$align`);
  console.log(`   POST /fhir/$report-data`);
  console.log(`   POST /fhir/Patient/$unalign`);
  console.log(`   GET  /fhir/Patient/$submission-status`);
  console.log(` ${c.blue("Debug:")}`);
  console.log(`   GET  /fhir/$mock-state`);
  console.log(`   POST /fhir/$mock-reset`);
  console.log(` ${c.blue("Config:")}`);
  console.log(`   LOCK_IN_DAYS=${LOCK_IN_DAYS}  BASELINE_WINDOW_DAYS=${BASELINE_WINDOW_DAYS}  ASYNC_DELAY_MS=${ASYNC_DELAY_MS}`);
  console.log(c.bold("============================================"));
  console.log("");
});
