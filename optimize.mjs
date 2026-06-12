#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

// Load historical match data
const D = (f) => new URL(`./data/${f}`, import.meta.url);
const { matches } = JSON.parse(readFileSync(D("results.json"), "utf8"));

// Seed priors
const SEED = {
  argentina: 2085, france: 2065, spain: 2055, brazil: 2045, england: 2000, portugal: 1980, netherlands: 1965, germany: 1945, belgium: 1925, italy: 1915, colombia: 1890, uruguay: 1875, croatia: 1870, morocco: 1840, switzerland: 1825, usa: 1830, mexico: 1825, japan: 1810, senegal: 1795, denmark: 1790, ecuador: 1760, australia: 1735, "south-korea": 1730, iran: 1720, poland: 1715, canada: 1700, serbia: 1695, wales: 1665, ghana: 1665, tunisia: 1655, "ivory-coast": 1655, nigeria: 1645, "saudi-arabia": 1640, qatar: 1630, egypt: 1620, algeria: 1615, scotland: 1610, cameroon: 1600, paraguay: 1595, venezuela: 1590, chile: 1580, peru: 1575, "czech-republic": 1570, "bosnia-and-herzegovina": 1545, "south-africa": 1520, "new-zealand": 1495, panama: 1480, jamaica: 1460, honduras: 1440, jordan: 1420, haiti: 1380, "el-salvador": 1370, "trinidad-and-tobago": 1360, guatemala: 1345
};

const BURN_IN = 150;

// Math utilities
function dcTau(a, b, lambda, mu, rho) {
  if (a === 0 && b === 0) return 1 - lambda * mu * rho;
  if (a === 0 && b === 1) return 1 + lambda * rho;
  if (a === 1 && b === 0) return 1 + mu * rho;
  if (a === 1 && b === 1) return 1 - rho;
  return 1;
}

function expectedScore(ratingA, ratingB, homeBonusA = 0) {
  return 1 / (1 + Math.pow(10, (ratingB - (ratingA + homeBonusA)) / 400));
}

function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

const gMult = (gd) => {
  const d = Math.abs(gd);
  return d <= 1 ? 1 : d === 2 ? 1.5 : (11 + d) / 8;
};

const rps3 = (p, y) => 0.5 * ((p[0] - y[0]) ** 2 + (p[0] + p[1] - y[0] - y[1]) ** 2);

// Evaluates model metrics for a specific set of parameters
function evaluateParameters(params) {
  const HOME_ADV = params.homeAdvantage;
  const DC_RHO = params.dcRho;
  const EG_BASE = params.expectedGoalsBase;
  const EG_DENOM = params.expectedGoalsDenom;
  const EG_MIN = params.expectedGoalsMin;
  const EG_MAX = params.expectedGoalsMax;

  const baseK = (n = "") => {
    n = n.toLowerCase();
    if (/world cup(?!.*qual)/.test(n)) return params.kWorldCup;
    if (/world cup.*qual|qualification/.test(n)) return params.kQual;
    if (/copa america|euro championship\b|asian cup|africa cup|gold cup/.test(n)) return params.kCup;
    if (/nations league|nations cup/.test(n)) return params.kNations;
    if (/friendl/.test(n)) return params.kFriendly;
    return params.kDefault;
  };

  const expectedGoals = (rating, opponent, homeBonus = 0) => {
    const diff = (rating + homeBonus) - opponent;
    const lambda = EG_BASE + diff / EG_DENOM;
    return Math.max(EG_MIN, Math.min(EG_MAX, lambda));
  };

  const matchProb = (ratingA, ratingB, homeBonusA = 0) => {
    const lambda = expectedGoals(ratingA, ratingB, homeBonusA);
    const mu = expectedGoals(ratingB, ratingA, -homeBonusA / 2);
    let winA = 0, draw = 0, winB = 0;
    for (let a = 0; a <= 8; a++) {
      const pA = poissonPmf(a, lambda);
      for (let b = 0; b <= 8; b++) {
        const tau = dcTau(a, b, lambda, mu, DC_RHO);
        const p = pA * poissonPmf(b, mu) * tau;
        if (a > b) winA += p; else if (a < b) winB += p; else draw += p;
      }
    }
    const total = winA + draw + winB;
    return { winA: winA / total, draw: draw / total, winB: winB / total };
  };

  const R = {};
  const getR = (s, nm) => {
    const k = s ?? `ghost:${nm}`;
    if (R[k] == null) R[k] = s && SEED[s] != null ? SEED[s] : 1500;
    return R[k];
  };
  const setR = (s, nm, v) => { R[s ?? `ghost:${nm}`] = v; };

  let n = 0, hit = 0, brier = 0, logloss = 0, favN = 0, favHit = 0;
  let rps = 0;
  let i = 0;

  for (const m of matches) {
    if (m.hg == null || m.ag == null) continue;
    const ra = getR(m.homeSlug, m.homeName), rb = getR(m.awaySlug, m.awayName);

    if (i >= BURN_IN) {
      const p = matchProb(ra, rb, HOME_ADV);
      const probs = [p.winA, p.draw, p.winB];
      const actual = m.hg > m.ag ? 0 : m.hg < m.ag ? 2 : 1;
      const y = [actual === 0 ? 1 : 0, actual === 1 ? 1 : 0, actual === 2 ? 1 : 0];
      const pred = probs.indexOf(Math.max(...probs));

      if (pred === actual) hit++;
      brier += (probs[0] - y[0]) ** 2 + (probs[1] - y[1]) ** 2 + (probs[2] - y[2]) ** 2;
      logloss += -Math.log(Math.max(1e-12, probs[actual]));
      rps += rps3(probs, y);

      if (Math.max(...probs) >= 0.5) {
        favN++;
        if (pred === actual) favHit++;
      }
      n++;
    }

    const exp = expectedScore(ra, rb, HOME_ADV);
    const score = m.hg > m.ag ? 1 : m.hg < m.ag ? 0 : 0.5;
    const delta = baseK(m.leagueName) * gMult(m.hg - m.ag) * (score - exp);
    setR(m.homeSlug, m.homeName, ra + delta);
    setR(m.awaySlug, m.awayName, rb - delta);
    i++;
  }

  return {
    accuracy: hit / n,
    favouriteAccuracy: favN ? favHit / favN : 0,
    brier: brier / n,
    logloss: logloss / n,
    rps: rps / n
  };
}

// Default parameters (baselines)
const defaultParams = {
  homeAdvantage: 75,
  dcRho: -0.13,
  expectedGoalsBase: 1.35,
  expectedGoalsDenom: 400,
  expectedGoalsMin: 0.3,
  expectedGoalsMax: 3.5,
  kWorldCup: 55,
  kQual: 40,
  kCup: 50,
  kNations: 32,
  kFriendly: 18,
  kDefault: 28
};

console.log("Evaluating baseline parameters...");
const baselineResults = evaluateParameters(defaultParams);
console.log(`Baseline RPS: ${baselineResults.rps.toFixed(5)} | Log-loss: ${baselineResults.logloss.toFixed(4)} | Accuracy: ${(baselineResults.accuracy * 100).toFixed(1)}%`);

// Define Search Space
const searchSpace = {
  homeAdvantage: { min: 30, max: 130, step: 5 },
  dcRho: { min: -0.25, max: 0.0, step: 0.01 },
  expectedGoalsBase: { min: 1.10, max: 1.60, step: 0.05 },
  expectedGoalsDenom: { min: 250, max: 600, step: 10 },
  kWorldCup: { min: 45, max: 70, step: 5 },
  kQual: { min: 30, max: 50, step: 5 },
  kCup: { min: 40, max: 60, step: 5 }
};

console.log("\nStarting Random Search phase (300 trials)...");
let bestParams = { ...defaultParams };
let bestRps = baselineResults.rps;

// Random Search
for (let trial = 1; trial <= 300; trial++) {
  const trialParams = { ...bestParams };
  
  // Randomly sample values from search space
  for (const [key, range] of Object.entries(searchSpace)) {
    const steps = Math.floor((range.max - range.min) / range.step);
    const randStep = Math.floor(Math.random() * (steps + 1));
    trialParams[key] = parseFloat((range.min + randStep * range.step).toFixed(4));
  }

  const res = evaluateParameters(trialParams);
  if (res.rps < bestRps) {
    bestRps = res.rps;
    bestParams = { ...trialParams };
    console.log(`  Trial ${trial}: Found better RPS! RPS = ${bestRps.toFixed(5)} (HomeAdv: ${bestParams.homeAdvantage}, Rho: ${bestParams.dcRho}, EGBase: ${bestParams.expectedGoalsBase}, EGDenom: ${bestParams.expectedGoalsDenom})`);
  }
}

console.log("\nStarting Coordinate Descent refinement phase...");
// Fine-tune coordinate-wise
let improved = true;
let pass = 1;
while (improved && pass <= 3) {
  improved = false;
  console.log(`  Refinement Pass ${pass}...`);
  for (const [key, range] of Object.entries(searchSpace)) {
    const currentVal = bestParams[key];
    const stepsToTry = [
      currentVal - range.step,
      currentVal + range.step,
      currentVal - range.step * 0.5,
      currentVal + range.step * 0.5
    ];

    for (let candidate of stepsToTry) {
      if (candidate < range.min || candidate > range.max) continue;
      candidate = parseFloat(candidate.toFixed(4));
      
      const testParams = { ...bestParams, [key]: candidate };
      const res = evaluateParameters(testParams);
      if (res.rps < bestRps) {
        bestRps = res.rps;
        bestParams = testParams;
        improved = true;
        console.log(`    Updated ${key} to ${candidate} -> RPS = ${bestRps.toFixed(5)}`);
      }
    }
  }
  pass++;
}

// Final evaluation
const optimizedResults = evaluateParameters(bestParams);

console.log("\n=========================================================");
console.log("                 OPTIMIZATION COMPLETE                   ");
console.log("=========================================================");
console.log("\n--- Parameter Comparison ---");
console.log(`Parameter              | Default   | Optimized`);
console.log(`-----------------------------------------------`);
console.log(`homeAdvantage          | 75        | ${bestParams.homeAdvantage}`);
console.log(`dcRho                  | -0.13     | ${bestParams.dcRho}`);
console.log(`expectedGoalsBase      | 1.35      | ${bestParams.expectedGoalsBase}`);
console.log(`expectedGoalsDenom     | 400       | ${bestParams.expectedGoalsDenom}`);
console.log(`kWorldCup              | 55        | ${bestParams.kWorldCup}`);
console.log(`kQual                  | 40        | ${bestParams.kQual}`);
console.log(`kCup                   | 50        | ${bestParams.kCup}`);

console.log("\n--- Metric Comparison ---");
console.log(`Metric           | Default    | Optimized  | Change`);
console.log(`-----------------------------------------------------`);
const formatMetric = (name, def, opt, desc = false) => {
  const diff = opt - def;
  const pct = (diff / def * 100);
  const diffSign = diff >= 0 ? "+" : "";
  const pctSign = pct >= 0 ? "+" : "";
  const pctText = desc ? `${pctSign}${pct.toFixed(2)}%` : `${diffSign}${diff.toFixed(4)} (${pctSign}${pct.toFixed(2)}%)`;
  return `${name.padEnd(16)} | ${def.toFixed(5)}    | ${opt.toFixed(5)}    | ${pctText}`;
};

console.log(formatMetric("RPS (↓)", baselineResults.rps, optimizedResults.rps));
console.log(formatMetric("Log-loss (↓)", baselineResults.logloss, optimizedResults.logloss));
console.log(formatMetric("Brier Score (↓)", baselineResults.brier, optimizedResults.brier));
console.log(`${"Accuracy (↑)".padEnd(16)} | ${(baselineResults.accuracy * 100).toFixed(2)}%   | ${(optimizedResults.accuracy * 100).toFixed(2)}%   | +${((optimizedResults.accuracy - baselineResults.accuracy) * 100).toFixed(2)}%`);
console.log(`${"Favourite Acc".padEnd(16)} | ${(baselineResults.favouriteAccuracy * 100).toFixed(2)}%   | ${(optimizedResults.favouriteAccuracy * 100).toFixed(2)}%   | +${((optimizedResults.favouriteAccuracy - baselineResults.favouriteAccuracy) * 100).toFixed(2)}%`);
console.log(`=========================================================\n`);

// Save optimized configuration to a file for review
const optConfigPath = "./data/elo-optimized-params.json";
writeFileSync(D("elo-optimized-params.json"), JSON.stringify({
  optimizedAt: new Date().toISOString(),
  parameters: bestParams,
  metrics: {
    baseline: baselineResults,
    optimized: optimizedResults
  }
}, null, 2) + "\n");
console.log(`💾 Saved optimized configuration to ${optConfigPath}`);
console.log(`To apply these parameters to predictions/simulations, update 'elo.mjs' and 'backtest.mjs' with the values listed above.`);
