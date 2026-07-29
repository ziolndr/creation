const CHEMBL = "https://www.ebi.ac.uk/chembl/api/data";

const json = (response, status, body) => {
  response.status(status);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, max-age=0"
  );
  return response.end(JSON.stringify(body));
};

const asArray = value => Array.isArray(value) ? value : [];

const finiteNumber = value => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const fetchJson = async (url, options = {}, timeoutMs = 18000) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "CREATION/1.0 intervention-design",
        "skip_zrok_interstitial": "1",
        ...(options.headers || {})
      }
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `${url} returned HTTP ${response.status}: ${text.slice(0, 220)}`
      );
    }

    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
};

const normalizeTargets = body => {
  const source = asArray(body.targets).length
    ? body.targets
    : asArray(body.cell_program?.targets);

  const seen = new Set();
  const targets = [];

  for (const item of source) {
    const symbol = String(
      item?.symbol ||
      item?.target ||
      item?.title ||
      ""
    ).trim();

    if (!symbol) continue;

    const normalized = symbol.toUpperCase();

    if (seen.has(normalized)) continue;
    seen.add(normalized);

    targets.push({
      rank: Number(item?.rank || targets.length + 1),
      symbol,
      accession: String(item?.accession || "").trim(),
      resonance: finiteNumber(item?.resonance),
      organism: String(item?.organism || "").trim()
    });

    if (targets.length >= 20) break;
  }

  return targets;
};

const targetText = target => {
  const pieces = [
    target.pref_name,
    ...asArray(target.target_components).flatMap(component => [
      component?.accession,
      ...asArray(component?.target_component_synonyms).flatMap(synonym => [
        synonym?.component_synonym,
        synonym?.syn_type
      ])
    ])
  ];

  return pieces.filter(Boolean).join(" ").toUpperCase();
};

const resolveTarget = async target => {
  const query = encodeURIComponent(target.symbol);
  const payload = await fetchJson(
    `${CHEMBL}/target/search.json?q=${query}&limit=20`
  );

  const candidates = asArray(payload.targets);

  const scored = candidates.map(candidate => {
    const text = targetText(candidate);
    const organism = String(candidate.organism || "").toLowerCase();
    const type = String(candidate.target_type || "").toUpperCase();

    let score = 0;
    if (text.includes(target.symbol.toUpperCase())) score += 8;
    if (organism.includes("homo sapiens")) score += 5;
    if (type === "SINGLE PROTEIN") score += 4;
    if (String(candidate.pref_name || "").toUpperCase() === target.symbol.toUpperCase()) score += 3;

    return { candidate, score };
  });

  scored.sort((left, right) => right.score - left.score);
  const best = scored[0]?.candidate;

  if (!best?.target_chembl_id) {
    return {
      ...target,
      resolved: false,
      target_chembl_id: null
    };
  }

  return {
    ...target,
    resolved: true,
    target_chembl_id: best.target_chembl_id,
    target_name: best.pref_name,
    target_type: best.target_type,
    target_organism: best.organism
  };
};

const fetchActivities = async target => {
  if (!target.target_chembl_id) return [];

  const params = new URLSearchParams({
    target_chembl_id: target.target_chembl_id,
    pchembl_value__isnull: "false",
    limit: "120"
  });

  const payload = await fetchJson(
    `${CHEMBL}/activity.json?${params.toString()}`
  );

  return asArray(payload.activities)
    .map(activity => ({
      symbol: target.symbol,
      target_chembl_id: target.target_chembl_id,
      target_name: target.target_name,
      molecule_chembl_id: activity.molecule_chembl_id,
      pchembl_value: finiteNumber(activity.pchembl_value),
      standard_type: activity.standard_type,
      standard_relation: activity.standard_relation,
      standard_value: finiteNumber(activity.standard_value),
      standard_units: activity.standard_units,
      assay_chembl_id: activity.assay_chembl_id,
      document_chembl_id: activity.document_chembl_id,
      canonical_smiles: activity.canonical_smiles || ""
    }))
    .filter(activity =>
      activity.molecule_chembl_id &&
      activity.pchembl_value !== null
    );
};

const median = values => {
  const sorted = values
    .filter(value => Number.isFinite(value))
    .slice()
    .sort((left, right) => left - right);

  if (!sorted.length) return null;

  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

const fetchMolecule = async chemblId => {
  try {
    return await fetchJson(
      `${CHEMBL}/molecule/${encodeURIComponent(chemblId)}.json`
    );
  } catch {
    return null;
  }
};

const buildExistingCandidates = async (resolvedTargets, activityGroups) => {
  const molecules = new Map();

  for (const activities of activityGroups) {
    for (const activity of activities) {
      const id = activity.molecule_chembl_id;

      if (!molecules.has(id)) {
        molecules.set(id, {
          id,
          targets: new Map(),
          activities: []
        });
      }

      const entry = molecules.get(id);
      entry.activities.push(activity);

      const previous = entry.targets.get(activity.symbol);
      if (!previous || activity.pchembl_value > previous.pchembl_value) {
        entry.targets.set(activity.symbol, activity);
      }
    }
  }

  const ranked = [...molecules.values()]
    .map(entry => {
      const targetActivities = [...entry.targets.values()];
      const values = targetActivities.map(item => item.pchembl_value);

      return {
        ...entry,
        coverage: targetActivities.length,
        median_pchembl: median(values),
        best_pchembl: values.length ? Math.max(...values) : null
      };
    })
    .sort((left, right) =>
      right.coverage - left.coverage ||
      (right.median_pchembl || 0) - (left.median_pchembl || 0) ||
      (right.best_pchembl || 0) - (left.best_pchembl || 0)
    )
    .slice(0, 30);

  const details = await Promise.all(
    ranked.map(entry => fetchMolecule(entry.id))
  );

  return ranked.map((entry, index) => {
    const detail = details[index] || {};
    const structures = detail.molecule_structures || {};
    const properties = detail.molecule_properties || {};
    const synonyms = asArray(detail.molecule_synonyms);

    const preferredSynonym = synonyms.find(item =>
      ["INN", "USAN", "BAN", "FDA", "BNF"].includes(
        String(item.syn_type || "").toUpperCase()
      )
    );

    const name =
      detail.pref_name ||
      preferredSynonym?.molecule_synonym ||
      entry.id;

    return {
      id: entry.id,
      chembl_id: entry.id,
      name,
      lane: "existing",
      source: "ChEMBL",
      status: "measured activity",
      smiles: structures.canonical_smiles ||
        entry.activities.find(item => item.canonical_smiles)?.canonical_smiles ||
        "",
      targets: [...entry.targets.values()].map(activity => ({
        symbol: activity.symbol,
        target_chembl_id: activity.target_chembl_id,
        target_name: activity.target_name,
        pchembl_value: activity.pchembl_value,
        standard_type: activity.standard_type,
        standard_value: activity.standard_value,
        standard_units: activity.standard_units
      })),
      target_coverage_count: entry.coverage,
      requested_target_count: resolvedTargets.length,
      median_pchembl: entry.median_pchembl === null
        ? null
        : Number(entry.median_pchembl.toFixed(2)),
      best_pchembl: entry.best_pchembl === null
        ? null
        : Number(entry.best_pchembl.toFixed(2)),
      max_phase: finiteNumber(detail.max_phase),
      properties,
      url: `https://www.ebi.ac.uk/chembl/explore/compound/${entry.id}`,
      evidence: entry.activities.slice(0, 12)
    };
  });
};

const bestCombination = (candidates, requestedTargets, maxSize = 3) => {
  if (!candidates.length) return null;

  const requested = new Set(
    requestedTargets.map(target => target.symbol.toUpperCase())
  );

  const selected = [];
  const covered = new Set();

  while (selected.length < maxSize && covered.size < requested.size) {
    let best = null;
    let bestGain = 0;

    for (const candidate of candidates) {
      if (selected.includes(candidate)) continue;

      const symbols = asArray(candidate.targets)
        .map(target => String(target.symbol || "").toUpperCase())
        .filter(symbol => requested.has(symbol));

      const gain = symbols.filter(symbol => !covered.has(symbol)).length;

      if (
        gain > bestGain ||
        (
          gain === bestGain &&
          gain > 0 &&
          (candidate.median_pchembl || 0) > (best?.median_pchembl || 0)
        )
      ) {
        best = candidate;
        bestGain = gain;
      }
    }

    if (!best || bestGain <= 0) break;

    selected.push(best);

    for (const target of best.targets) {
      const symbol = String(target.symbol || "").toUpperCase();
      if (requested.has(symbol)) covered.add(symbol);
    }
  }

  if (selected.length < 2) return null;

  return {
    id: `CREATION-COMBINATION-${selected.map(item => item.chembl_id).join("-")}`,
    name: selected.map(item => item.name).join(" + "),
    lane: "combination",
    source: "ChEMBL measured-activity assembly",
    status: "combination hypothesis",
    components: selected,
    targets: [...covered].map(symbol => ({ symbol })),
    target_coverage_count: covered.size,
    requested_target_count: requested.size,
    median_pchembl: median(
      selected
        .map(item => item.median_pchembl)
        .filter(value => value !== null)
    ),
    url: selected[0].url
  };
};

const waitForEnrichJob = milliseconds =>
  new Promise(resolve =>
    setTimeout(resolve, milliseconds)
  );

// BEGIN CREATION ASYNC WORKER CLIENT V1
const proxyWorker = async (workerUrl, body) => {
  const root = workerUrl.replace(/\/+$/, "");
  const base = await localKnownChemistry(body);

  const submitted = await fetchJson(
    `${root}/v1/enrich/jobs`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        request: body,
        base
      })
    },
    30000
  );

  const jobId = String(
    submitted?.job_id || ""
  ).trim();

  if (!jobId) {
    throw new Error(
      "CREATION worker did not return a job_id"
    );
  }

  const deadline =
    Date.now() + 30 * 60 * 1000;

  while (Date.now() < deadline) {
    const job = await fetchJson(
      `${root}/v1/enrich/jobs/${encodeURIComponent(jobId)}`,
      {},
      30000
    );

    const status = String(
      job?.status || ""
    ).toLowerCase();

    if (status === "complete") {
      if (
        !job.result ||
        typeof job.result !== "object"
      ) {
        throw new Error(
          `CREATION worker job ${jobId} completed without a result`
        );
      }

      return job.result;
    }

    if (status === "failed") {
      const detail =
        job?.error?.exception ||
        job?.error?.error ||
        job?.detail ||
        `CREATION worker job ${jobId} failed`;

      throw new Error(String(detail));
    }

    await waitForEnrichJob(2000);
  }

  throw new Error(
    `CREATION worker job ${jobId} exceeded 30 minutes`
  );
};
// END CREATION ASYNC WORKER CLIENT V1

const localKnownChemistry = async body => {
  const targets = normalizeTargets(body);

  if (!targets.length) {
    throw new Error("No target symbols were supplied");
  }

  const resolvedTargets = await Promise.all(
    targets.map(target =>
      resolveTarget(target).catch(error => ({
        ...target,
        resolved: false,
        error: String(error)
      }))
    )
  );

  const mapped = resolvedTargets.filter(target => target.resolved);

  const activityGroups = await Promise.all(
    mapped.map(target =>
      fetchActivities(target).catch(() => [])
    )
  );

  const existing = await buildExistingCandidates(
    mapped,
    activityGroups
  );

  const mode = String(body.design_mode || "existing");
  const candidates = [];

  if (["existing", "all", "de_novo", "combination"].includes(mode)) {
    candidates.push(...existing.slice(0, 24));
  }

  if (["combination", "all"].includes(mode)) {
    const combination = bestCombination(
      existing,
      mapped,
      Math.max(
        2,
        Math.min(
          3,
          Number(body.constraints?.max_combination_size || 3)
        )
      )
    );

    if (combination) candidates.unshift(combination);
  }

  const generationRequested = ["de_novo", "all"].includes(mode);

  return {
    schema_version: 1,
    provider: "CREATION ChEMBL direct",
    design_mode: mode,
    generated_at: new Date().toISOString(),
    intent: body.intent || body.cell_program?.spoken_intent || "",
    requested_targets: targets,
    resolved_targets: resolvedTargets,
    candidates,
    message: candidates.length
      ? `${candidates.length} measured-chemistry candidates returned`
      : "No measured ChEMBL candidates were returned for the mapped targets",
    pipeline: {
      target_map: {
        state: mapped.length ? "complete" : "unavailable",
        label: `${mapped.length}/${targets.length} mapped`
      },
      known_chemistry: {
        state: existing.length ? "complete" : "unavailable",
        label: `${existing.length} candidates`
      },
      generation: {
        state: generationRequested ? "unavailable" : "waiting",
        label: generationRequested
          ? "Worker not configured"
          : "Not requested"
      },
      admet: {
        state: "unavailable",
        label: "Worker not configured"
      },
      binding: {
        state: "unavailable",
        label: "Worker not configured"
      },
      synthesis: {
        state: "unavailable",
        label: "Worker not configured"
      },
      arbiter: {
        state: "unavailable",
        label: "Worker not configured"
      }
    }
  };
};

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return json(response, 405, {
      error: "method not allowed"
    });
  }

  const body = request.body && typeof request.body === "object"
    ? request.body
    : {};

  try {
    const workerUrl = String(
      process.env.CREATION_CHEMISTRY_URL || "https://creation-chemistry.shares.zrok.io"
    ).trim();

    const result = workerUrl
      ? await proxyWorker(workerUrl, body)
      : await localKnownChemistry(body);

    return json(response, 200, result);
  } catch (error) {
    return json(response, 502, {
      error: "intervention design failed",
      detail: String(error?.message || error)
    });
  }
}
