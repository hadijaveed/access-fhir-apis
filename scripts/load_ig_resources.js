#!/usr/bin/env node
// =============================================================================
// ACCESS Model FHIR IG Resource Loader
// Loads CodeSystems, ValueSets, StructureDefinitions, OperationDefinitions,
// CapabilityStatements, and example resources into a HAPI FHIR R4 server.
// =============================================================================

import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const FHIR_BASE = process.env.FHIR_BASE || "http://localhost:8080/fhir";
const IG_DIR = join(import.meta.dirname, "../ig");

const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
};

let loaded = 0,
  failed = 0,
  skipped = 0;

async function waitForServer() {
  console.log(`Waiting for FHIR server at ${FHIR_BASE}...`);
  for (let i = 1; i <= 60; i++) {
    try {
      const res = await fetch(`${FHIR_BASE}/metadata`);
      if (res.ok) {
        console.log(c.green("Server is ready!"));
        return;
      }
    } catch {}
    console.log(`  Attempt ${i}/60 - waiting 5s...`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("Server did not start in time");
}

async function loadResource(filePath) {
  let data;
  try {
    data = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    console.log(`  ${c.yellow("SKIP")} ${filePath} (invalid JSON)`);
    skipped++;
    return;
  }

  const { resourceType, id } = data;
  if (!resourceType || !id) {
    console.log(`  ${c.yellow("SKIP")} ${filePath} (no resourceType/id)`);
    skipped++;
    return;
  }

  const url = `${FHIR_BASE}/${resourceType}/${id}`;
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/fhir+json" },
      body: JSON.stringify(data),
    });

    if (res.status === 200 || res.status === 201) {
      console.log(
        `  ${c.green("OK")}   ${resourceType}/${id} (HTTP ${res.status})`
      );
      loaded++;
    } else {
      const body = await res.text();
      console.log(
        `  ${c.red("FAIL")} ${resourceType}/${id} (HTTP ${res.status})`
      );
      if (body.length < 200) console.log(`        ${body}`);
      failed++;
    }
  } catch (err) {
    console.log(`  ${c.red("FAIL")} ${resourceType}/${id} (${err.message})`);
    failed++;
  }
}

function getFiles(prefix) {
  return readdirSync(IG_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .sort()
    .map((f) => join(IG_DIR, f));
}

async function main() {
  console.log("");
  console.log(c.bold("============================================"));
  console.log(c.bold(" ACCESS Model FHIR IG Resource Loader"));
  console.log(c.bold("============================================"));
  console.log("");

  await waitForServer();

  const steps = [
    ["Step 1: CodeSystems", "CodeSystem-"],
    ["Step 2: ValueSets", "ValueSet-"],
    ["Step 3: StructureDefinitions", "StructureDefinition-"],
    ["Step 4: OperationDefinitions", "OperationDefinition-"],
    ["Step 5: CapabilityStatements", "CapabilityStatement-"],
  ];

  for (const [label, prefix] of steps) {
    console.log(`\n--- ${label} ---`);
    for (const f of getFiles(prefix)) {
      await loadResource(f);
    }
  }

  // Step 6: Example resources
  console.log("\n--- Step 6: Example Resources ---");
  const examplePrefixes = [
    "Patient-",
    "Condition-",
    "Practitioner-",
    "Organization-",
  ];
  for (const prefix of examplePrefixes) {
    for (const f of getFiles(prefix)) {
      await loadResource(f);
    }
  }

  console.log("");
  console.log(c.bold("============================================"));
  console.log(
    ` Loaded: ${c.green(loaded)}  Failed: ${c.red(failed)}  Skipped: ${c.yellow(skipped)}`
  );
  console.log(c.bold("============================================"));

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(c.red(err.message));
  process.exit(1);
});
