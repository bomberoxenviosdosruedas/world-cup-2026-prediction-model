#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import { matchProb } from "./elo.mjs";

const D = (f) => new URL(`./data/${f}`, import.meta.url);

// Helper function to fetch data from a URL
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`Failed to fetch ${url}: Status ${res.statusCode}`));
      }
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => { resolve(body); });
    }).on("error", (err) => { reject(err); });
  });
}

// Host teams and Home Advantage definition
const HOST = new Set(["mexico", "usa", "canada"]);
const HOME_ADV = 75;

async function main() {
  console.log("=========================================================");
  console.log("            FETCHING LIVE DATA FROM PRODUCTION           ");
  console.log("=========================================================\n");

  // 1. Fetch live tournament probabilities
  const probUrl = "https://cup26matches.com/data/probabilities.json";
  console.log(`🌐 Fetching tournament probabilities from: ${probUrl}...`);
  let probDataRaw;
  try {
    probDataRaw = await fetchUrl(probUrl);
    writeFileSync(D("live-probabilities.json"), probDataRaw, "utf8");
    console.log("💾 Saved live tournament probabilities to: data/live-probabilities.json");
  } catch (err) {
    console.error(`❌ Error fetching probabilities JSON: ${err.message}`);
  }

  if (probDataRaw) {
    try {
      const probData = JSON.parse(probDataRaw);
      console.log(`\n🏆 TOP 10 TITLE FAVOURITES (Live Sim: ${probData.trials.toLocaleString()} trials):`);
      console.log(`-----------------------------------------------`);
      console.log(`Rank | Team            | Champ % | Group Exit % | Avg Pts`);
      console.log(`-----------------------------------------------`);
      probData.teams.slice(0, 10).forEach((t, idx) => {
        const name = t.slug.toUpperCase().padEnd(15, " ");
        const champ = (t.pChampion * 100).toFixed(2).padStart(6, " ") + "%";
        const exit = (t.pGroupExit * 100).toFixed(1).padStart(6, " ") + "%";
        const pts = t.avgGroupPoints.toFixed(2).padStart(6, " ");
        console.log(`  ${String(idx + 1).padStart(2)}. | ${name} | ${champ} | ${exit} | ${pts}`);
      });
      console.log(`-----------------------------------------------\n`);
    } catch (e) {
      console.error(`❌ Error parsing probabilities JSON: ${e.message}`);
    }
  }

  // 2. Fetch matches HTML page
  const matchesUrl = "https://cup26matches.com/es/matches/";
  console.log(`🌐 Fetching matches calendar from: ${matchesUrl}...`);
  let html;
  try {
    html = await fetchUrl(matchesUrl);
  } catch (err) {
    console.error(`❌ Error fetching matches HTML: ${err.message}`);
    process.exit(1);
  }

  // Parse matches from HTML using regular expressions
  // Each match is inside an <a> tag starting with href="/es/match/..."
  const matchRegex = /<a\s+href="\/es\/match\/([^/"]+)\/"[^>]*>([\s\S]*?)<\/a>/g;
  const matchesFound = [];
  let match;

  while ((match = matchRegex.exec(html)) !== null) {
    const slug = match[1];
    const block = match[2];

    // Parse teams from the block (usually inside class truncate font-display)
    const teamRegex = /<span class="truncate font-display text-sm md:text-lg">([^<]+)<\/span>/g;
    const teams = [];
    let tMatch;
    while ((tMatch = teamRegex.exec(block)) !== null) {
      teams.push(tMatch[1].trim());
    }

    // Parse W/D/L probabilities from the width percentages of the style tags
    // e.g. style="width:58.81211242762732%"
    const probRegex = /style="width:([\d.]+)%"/g;
    const probs = [];
    let pMatch;
    while ((pMatch = probRegex.exec(block)) !== null) {
      probs.push(parseFloat(pMatch[1]) / 100);
    }

    if (teams.length >= 2 && probs.length >= 3) {
      matchesFound.push({
        slug,
        teamA: teams[0],
        teamB: teams[1],
        liveProbA: probs[0],
        liveProbDraw: probs[1],
        liveProbB: probs[2]
      });
    }
  }

  console.log(`✓ Parsed ${matchesFound.length} matches from matches HTML.`);

  if (matchesFound.length === 0) {
    console.warn("⚠️ No upcoming matches parsed from HTML. The site layout might have changed, or matches are already completed.");
    process.exit(0);
  }

  // Load local calibrated Elo
  let eloRatings = {};
  try {
    const eloData = JSON.parse(readFileSync(D("elo-calibrated.json"), "utf8"));
    eloRatings = eloData.ratings || {};
  } catch (err) {
    console.warn("⚠️ Could not load data/elo-calibrated.json. Using fallback ratings.");
  }

  console.log(`\n🔍 COMPARING LIVE PROBABILITIES VS LOCAL MODEL FOR UPCOMING MATCHES:`);
  console.log(`================================================================================`);
  console.log(`Match / Teams                     | Live (W - D - L)    | Local (W - D - L)   | Diff`);
  console.log(`================================================================================`);

  const results = [];

  for (const m of matchesFound) {
    // Parse slug to get exact team keys
    // e.g. canada-vs-bosnia-and-herzegovina-2026-06-12
    const parsed = m.slug.match(/^([\w\-]+)-vs-([\w\-]+)-(\d{4}-\d{2}-\d{2})$/);
    if (!parsed) continue;

    const slugA = parsed[1];
    const slugB = parsed[2];
    const date = parsed[3];

    const ratingA = eloRatings[slugA];
    const ratingB = eloRatings[slugB];

    if (ratingA == null || ratingB == null) {
      // Team rating missing locally
      console.log(`  📍 ${m.teamA} vs ${m.teamB} (${date})`);
      console.log(`     [Missing local Elo data for "${slugA}" or "${slugB}"]`);
      console.log(`--------------------------------------------------------------------------------`);
      continue;
    }

    // Calculate home advantage
    const hb = (HOST.has(slugA) ? HOME_ADV : 0) - (HOST.has(slugB) ? HOME_ADV : 0);
    const localProbs = matchProb(ratingA, ratingB, hb);

    const formatProbs = (w, d, l) => 
      `${(w * 100).toFixed(0)}% - ${(d * 100).toFixed(0)}% - ${(l * 100).toFixed(0)}%`;

    const liveStr = formatProbs(m.liveProbA, m.liveProbDraw, m.liveProbB);
    const localStr = formatProbs(localProbs.winA, localProbs.draw, localProbs.winB);

    // Calculate maximum absolute difference across outcome probabilities
    const diffA = Math.abs(m.liveProbA - localProbs.winA) * 100;
    const diffDraw = Math.abs(m.liveProbDraw - localProbs.draw) * 100;
    const diffB = Math.abs(m.liveProbB - localProbs.winB) * 100;
    const maxDiff = Math.max(diffA, diffDraw, diffB).toFixed(1) + "%";

    const matchLabel = `${m.teamA} vs ${m.teamB}`.substring(0, 32).padEnd(33, " ");
    console.log(`  ${matchLabel} | ${liveStr.padEnd(19, " ")} | ${localStr.padEnd(19, " ")} | max ${maxDiff}`);

    results.push({
      slug: m.slug,
      teamA: m.teamA,
      teamB: m.teamB,
      slugA,
      slugB,
      date,
      live: { winA: m.liveProbA, draw: m.liveProbDraw, winB: m.liveProbB },
      local: { winA: localProbs.winA, draw: localProbs.draw, winB: localProbs.winB },
      diff: { winA: m.liveProbA - localProbs.winA, draw: m.liveProbDraw - localProbs.draw, winB: m.liveProbB - localProbs.winB }
    });
  }

  console.log(`================================================================================`);
  
  // Save comparison results to a file
  writeFileSync(D("live-comparison.json"), JSON.stringify(results, null, 2) + "\n");
  console.log("💾 Saved detailed comparison report to: data/live-comparison.json\n");
}

main().catch((err) => {
  console.error("❌ Fatal Error in script:", err);
});
