// background.js - Groq AI & Auto-Search Orchestrator
//
// Drives the whole run: one Naukri search for all roles and locations together, scans each
// results page, matches jobs against the profile, and applies to matches in a background tab.

// Your Groq API key lives in config.js (git-ignored; copy config.example.js to create it).
importScripts("config.js");
const GROQ_API_KEY = self.GROQ_API_KEY;

// Tried in order; the next one is used when a model is rate-limited or unavailable.
const GROQ_MODELS = ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"];

// The run keeps going until the daily limit is reached or Naukri has no more pages;
// this is only a safety cap.
const MAX_PAGES_PER_SEARCH = 100;

// At most this many submitted applications per day (resets at local midnight), to stay
// closer to human volume and protect the Naukri account.
const DAILY_LIMIT = 50;
const QUOTA_MESSAGE = `${DAILY_LIMIT} jobs applied today. Daily quota is ${DAILY_LIMIT} jobs — auto-apply will be available again tomorrow.`;

let isRunning = false;
let logTabId = null;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "GENERATE_ANSWER") {
    handleAIAnswerGeneration(request.data)
      .then(answer => sendResponse({ success: true, answer }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep async channel open
  }

  if (request.action === "REAL_INPUT") {
    realInput(sender.tab?.id, request)
      .then(() => sendResponse({ ok: true }))
      .catch(error => {
        console.warn("[Job AI Co-Pilot] real input failed, page will fall back:", error.message);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (request.action === "EXTRACT_PROFILE") {
    extractProfileFromResume(request.text)
      .then(profile => sendResponse({ success: true, profile }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === "LAUNCH_AUTO_SEARCH") {
    if (isRunning) {
      sendResponse({ status: "Already running." });
      return;
    }
    getTodayCount().then(count => {
      if (count >= DAILY_LIMIT) {
        sendResponse({ status: QUOTA_MESSAGE, quotaReached: true });
      } else {
        runAutoApply(request.preferences);
        sendResponse({ status: `Searching all roles and locations... (${DAILY_LIMIT - count} applications left today)` });
      }
    });
    return true;
  }

  if (request.action === "RECHECK_MANUAL") {
    if (isRunning) {
      sendResponse({ status: "Stop the auto-apply run first." });
      return;
    }
    recheckManualJobs()
      .then(({ checked, nowApplied }) => sendResponse({
        status: `Re-checked ${checked} job(s): ${nowApplied} were already applied on Naukri.`
      }))
      .catch(error => sendResponse({ status: `Re-check failed: ${error.message}` }));
    return true;
  }

  if (request.action === "STOP_AUTO_SEARCH") {
    isRunning = false;
    sendResponse({ status: "Stopping after the current step." });
  }
});

// Logs to the service worker console and to the Naukri tab's console, with the clock time.
function log(text) {
  const line = `[${new Date().toLocaleTimeString("en-GB")}] ${text}`;
  console.log("[Job AI Co-Pilot]", line);
  if (logTabId) chrome.tabs.sendMessage(logTabId, { action: "LOG", text: line }).catch(() => {});
}

// 34200 -> "34.2s", 754000 -> "12m 34s"
function formatDuration(ms) {
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.round(sec % 60);
  return h ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

async function runAutoApply(profile) {
  isRunning = true;
  // Timing: whole run, and time spent applying (excluding the pauses between jobs).
  const runStarted = Date.now();
  let applyTimeMs = 0;
  let applied = 0;
  let runError = null;

  // Everything runs inside try, so isRunning is reset even if setup fails (otherwise
  // every later Start would answer "Already running.").
  try {
    const [searchTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    logTabId = searchTab.id;

    // Fix typos ("hyderbad", "banglore") before searching and matching.
    const { roles, locations } = await correctSearchTerms(
      splitList(profile.targetRole), splitList(profile.targetLocation)
    );
    profile = { ...profile, targetRole: roles.join(", "), targetLocation: locations.join(", ") };
    const years = parseYears(profile.totalExp);

    // Jobs already applied to (from earlier runs) or already looked at in this run.
    const { appliedJobs = [] } = await chrome.storage.local.get('appliedJobs');
    // "Apply on company site" entries are re-checked each run, since older versions
    // wrongly marked some direct-apply jobs that way.
    const seen = new Set(
      appliedJobs.filter(j => j.status !== "Apply on company site").map(j => j.url).filter(Boolean)
    );

    let todayCount = await getTodayCount();

    const rolesText = roles.join(", ");
    const locationsText = locations.join(", ");

    // Naukri redirects page 1 to its own location slug (e.g. "hyderabad" ->
    // "hyderabad-secunderabad"); later pages must be built from that final URL.
    let firstPageUrl = null;

    searchLoop:
    for (let page = 1; page <= MAX_PAGES_PER_SEARCH; page++) {
      if (!isRunning) break searchLoop;

      const pageUrl = page === 1
        ? buildNaukriSearchUrl(roles, locations, years, profile.jobAge || 3)
        : withPageNumber(firstPageUrl, page);
      let landedUrl = await navigate(searchTab.id, pageUrl);

      if (page === 1) {
        // Naukri's redirect to its own slug can drop the Freshness / experience filters:
        // put them back on the landed URL and load it again.
        const sent = new URL(pageUrl).searchParams;
        const landed = new URL(landedUrl);
        const dropped = ["jobAge", "experience"].filter(k => sent.has(k) && landed.searchParams.get(k) !== sent.get(k));
        if (dropped.length) {
          log(`  Naukri dropped the ${dropped.join(" / ")} filter; adding it back.`);
          for (const k of dropped) landed.searchParams.set(k, sent.get(k));
          landedUrl = await navigate(searchTab.id, landed.toString());
        }
        firstPageUrl = landedUrl;
      } else if (!new URL(landedUrl).pathname.endsWith(`-${page}`)) {
        log(`No more results after page ${page - 1}.`);
        break; // Naukri sent us back to page 1: no more pages
      }

      log(`Searching "${rolesText}" in ${locationsText}, posted within ${profile.jobAge || 3} days (page ${page})...`);
      if (page === 1) log(`  ${landedUrl}`);

      let jobs;
      try {
        jobs = await scanResults(searchTab.id);
      } catch (error) {
        log(`Could not scan page ${page} (${error.message}); reloading it once...`);
        landedUrl = await navigate(searchTab.id, landedUrl);
        jobs = await scanResults(searchTab.id);
      }
      const alreadySeen = jobs.filter(job => seen.has(job.url)).length;
      log(`Found ${jobs.length} jobs on this page` +
        (alreadySeen ? ` (${alreadySeen} already in your Job Log, skipped).` : "."));
      if (jobs.length === 0) {
        log("No more jobs in this search.");
        break;
      }

      for (const job of jobs) {
        if (!isRunning) break searchLoop;
        if (seen.has(job.url)) continue;
        seen.add(job.url);

        const verdict = await matchJob(job, profile, years);
        const tag = `"${job.title}" @ ${job.company || "?"} (${job.experience || "exp n/a"}, ${job.posted || "date n/a"})`;

        if (!verdict.ok) {
          log(`✗ ${tag}: ${verdict.reason}`);
          continue;
        }

        if (todayCount >= DAILY_LIMIT) {
          log(`Daily quota reached: ${QUOTA_MESSAGE}`);
          notifyUser(QUOTA_MESSAGE);
          break searchLoop;
        }

        log(`✓ ${tag}: ${verdict.reason}. Applying...`);
        const jobStarted = Date.now();
        const result = await applyInNewTab(job.url)
          .catch(error => ({ status: "error", reason: error.message }));
        const jobMs = Date.now() - jobStarted;
        const questionCount = result?.answers?.length || 0;
        log(`  → ${result?.status} in ${formatDuration(jobMs)}` +
          (questionCount ? ` (${questionCount} question${questionCount > 1 ? "s" : ""})` : "") +
          (result?.reason ? ` (${result.reason})` : ""));

        if (result?.status === "external") {
          await recordApplication(job, verdict.reason, {
            status: "Apply on company site",
            companyWebsite: result.companyWebsite,
            timeTakenMs: jobMs
          });
          log(result.companyWebsite
            ? `  Saved to sheet: ${result.companyWebsite}`
            : `  Careers page link not captured; open the Naukri job link to apply.`);
        }

        for (const { question, answer } of result?.answers || []) {
          log(`    Q: ${question.slice(0, 100)}  →  A: ${answer}`);
        }

        // Keep the latest stuck question's snapshot for the popup's "Copy debug info".
        if (result?.debug) await chrome.storage.local.set({ lastStuckDebug: result.debug });

        // Only "Applied" means a confirmed submission (Naukri showed success, or the
        // reloaded job page shows Applied). Nothing else counts as applied.
        const applyStatus = {
          applied: "Applied",
          unconfirmed: "Not confirmed (check on Naukri)",
          failed: "Apply manually",
          error: "Apply manually" // still logged, so "Re-check" can find it if Naukri counted it
        }[result?.status];

        if (applyStatus) {
          if (result.status === "applied") {
            applied++;
            applyTimeMs += jobMs;
            todayCount = await addToTodayCount();
            log(`  Today: ${todayCount} / ${DAILY_LIMIT} applied`);
          }
          await recordApplication(
            job,
            result.reason ? `${verdict.reason} | ${result.reason}` : verdict.reason,
            { status: applyStatus, timeTakenMs: jobMs }
          );

          // Stop straight after the last allowed application (no pause, no next job).
          if (todayCount >= DAILY_LIMIT) {
            log(`Daily quota reached: ${QUOTA_MESSAGE}`);
            notifyUser(QUOTA_MESSAGE);
            break searchLoop;
          }

          // Random delay (12 to 18 seconds) between applications to avoid bot triggers
          const randomDelay = Math.floor(Math.random() * 6000) + 12000;
          log(`Pausing ${formatDuration(randomDelay)} before the next job...`);
          await delay(randomDelay);
        }
      }
    }
  } catch (error) {
    runError = error;
    log(`Run stopped by an error: ${error.message}`);
  } finally {
    isRunning = false;
    const totalMs = Date.now() - runStarted;
    log(`${runError ? "Run ended early" : "Run complete"}. Applied to ${applied} job(s) in ${formatDuration(totalMs)}.`);
    if (applied) {
      log(`  Average per application: ${formatDuration(applyTimeMs / applied)} applying, ` +
        `${formatDuration(totalMs / applied)} including searching and pauses.`);
    }
  }
}

// ---------- Real input (chrome.debugger) ----------
// Sends trusted mouse/keyboard input to a tab, exactly like a person using it. Chrome shows
// a "started debugging this browser" bar while attached; we attach only to job tabs while
// applying and detach when the tab closes.

const attachedTabs = new Set();
chrome.debugger.onDetach.addListener(({ tabId }) => attachedTabs.delete(tabId));

async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attachedTabs.add(tabId);
}

const cdp = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params);

async function realInput(tabId, { type, x, y, text, key }) {
  if (!tabId) throw new Error("no tab");
  await ensureAttached(tabId);

  if (type === "click") {
    // The page measures in CSS pixels; mouse input is in screen units, which differ when
    // the page is zoomed (Ctrl +/-).
    const zoom = await chrome.tabs.getZoom(tabId).catch(() => 1);
    x *= zoom;
    y *= zoom;
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await delay(40 + Math.random() * 60);
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await delay(50 + Math.random() * 70);
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  } else if (type === "text") {
    // One character at a time, at a natural typing pace.
    for (const char of text) {
      await cdp(tabId, "Input.insertText", { text: char });
      await delay(35 + Math.random() * 65);
    }
  } else if (type === "key" && key === "Enter") {
    const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...enter });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...enter });
  } else {
    throw new Error(`unknown input type: ${type}`);
  }
}

async function detachDebugger(tabId) {
  if (!attachedTabs.has(tabId)) return;
  attachedTabs.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

// ---------- Re-check "Apply manually" jobs ----------
// Opens each "Apply manually" job and asks Naukri whether it's already applied (often the
// application went through on clicking Apply, before an extra question got stuck).
async function recheckManualJobs() {
  const { appliedJobs = [] } = await chrome.storage.local.get('appliedJobs');
  const manual = appliedJobs.filter(job => job.url &&
    ["Apply manually", "Not confirmed (check on Naukri)", "Applied (not confirmed - check)"].includes(job.status));
  let nowApplied = 0;

  for (const job of manual) {
    const tab = await chrome.tabs.create({ url: job.url, active: false });
    try {
      await waitForTabLoad(tab.id).catch(() => {});
      await delay(2500);
      const check = await chrome.tabs.sendMessage(tab.id, { action: "CHECK_APPLIED" }).catch(() => null);
      if (check?.applied) {
        job.status = "Applied";
        job.description = `${job.description} | confirmed on job page by re-check`;
        nowApplied++;
      }
    } finally {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
    await delay(1500);
  }

  await chrome.storage.local.set({ appliedJobs }); // rows were updated in place
  return { checked: manual.length, nowApplied };
}

// ---------- Daily quota ----------

// Local date as YYYY-MM-DD, so the count resets at the user's midnight.
const todayKey = () => new Date().toLocaleDateString("en-CA");

// Today's confirmed applications: the larger of the running counter and today's
// "Applied" rows in the log (so clearing the log doesn't reset the quota). Only status
// "Applied" counts: not "Not confirmed", "Apply manually" or "Apply on company site".
async function getTodayCount() {
  const { dailyQuota, appliedJobs = [] } = await chrome.storage.local.get(['dailyQuota', 'appliedJobs']);
  const counter = dailyQuota?.date === todayKey() ? dailyQuota.count : 0;
  const today = new Date().toLocaleDateString();
  const fromLog = appliedJobs.filter(j => j.appliedDate === today && j.status === "Applied").length;
  return Math.max(counter, fromLog);
}

async function addToTodayCount() {
  const count = (await getTodayCount()) + 1;
  await chrome.storage.local.set({ dailyQuota: { date: todayKey(), count } });
  return count;
}

// Shows a message box in the Naukri tab the run was started from.
function notifyUser(text) {
  if (logTabId) {
    chrome.tabs.update(logTabId, { active: true }).catch(() => {});
    chrome.tabs.sendMessage(logTabId, { action: "SHOW_ALERT", text }).catch(() => {});
  }
}

// ---------- Matching ----------

const GENERIC_ROLE_WORDS = new Set([
  "developer", "engineer", "senior", "junior", "sr", "jr", "lead", "software",
  "associate", "specialist", "and", "the", "of", "for", "in", "with"
]);

// Lowercases and unifies common spellings so "Front-End", "front end" and "frontend" all match.
function normalize(text) {
  const t = (text || "").toLowerCase()
    .replace(/front[\s-]?end/g, "frontend")
    .replace(/back[\s-]?end/g, "backend")
    .replace(/full[\s-]?stack/g, "fullstack")
    .replace(/\b(react|node|vue|next|express)\.?js\b/g, "$1")
    .replace(/\.(?=\s|$)/g, " ")
    .replace(/[^a-z0-9+#.]+/g, " ");
  return ` ${t.trim()} `;
}

const hasTerm = (normText, term) => term && normText.includes(` ${term} `);

// Apply only when you have at least this share of the skills the job asks for, so a
// job that shares just one skill out of many with you isn't applied to.
const MIN_SKILL_MATCH = 0.2;

// Experience must fit (your Total Experience inside the job's range, e.g. 3 fits
// "2-5", "0-3", "3+", "3"). Then you must have at least MIN_SKILL_MATCH of the
// job's skills (see scoreSkills).
async function matchJob(job, profile, years) {
  // Naukri's jobAge filter should already exclude old jobs; this catches any that slip through.
  const maxAge = Number(profile.jobAge) || 3;
  const ageDays = parsePostedDays(job.posted);
  if (ageDays != null && ageDays > maxAge) {
    return { ok: false, reason: `posted ${job.posted.toLowerCase()} (limit ${maxAge} days)` };
  }

  const range = parseExpRange(job.experience);
  if (years == null) return { ok: false, reason: "your Total Experience is not set" };
  if (!range) return { ok: false, reason: "job doesn't list experience" };
  if (years < range.min || years > range.max) {
    return { ok: false, reason: `experience ${range.label} doesn't fit your ${years} yrs` };
  }

  const title = normalize(job.title);
  const roleHit = splitList(profile.targetRole).find(role => {
    const tokens = normalize(role).trim().split(" ");
    const keywords = tokens.filter(t => !GENERIC_ROLE_WORDS.has(t));
    return (keywords.length ? keywords : tokens).every(t => hasTerm(title, t));
  });

  const reasons = [`exp ${range.label}`];
  if (roleHit) reasons.push(`role ~ ${roleHit}`);

  const mySkills = splitList(profile.skills);
  if (mySkills.length === 0) return { ok: false, reason: "your Key Skills are not set" };

  const { jobSkills, matched } = await scoreSkills(job, mySkills);
  if (jobSkills.length === 0) {
    // Nothing to score against: fall back to the title matching one of your roles.
    return roleHit
      ? { ok: true, reason: [...reasons, "no skills listed on the job"].join("; ") }
      : { ok: false, reason: "job lists no skills and the title doesn't match your roles" };
  }

  const score = matched.length / jobSkills.length;
  const missing = jobSkills.filter(s => !matched.includes(s));
  const scoreText = `skill match ${Math.round(score * 100)}% (${matched.length}/${jobSkills.length})`;
  if (score < MIN_SKILL_MATCH) {
    return {
      ok: false,
      reason: `${scoreText}, need ${MIN_SKILL_MATCH * 100}%; missing: ${missing.join(", ")}`
    };
  }

  reasons.push(scoreText, `skills: ${matched.join(", ")}`);
  return { ok: true, reason: reasons.join("; ") };
}

// Lists the skills the job asks for and which of them you have. The AI reads the job
// card (title, key-skill tags, description) and counts equivalent names as a match
// ("ReactJS" = "React", "JS" = "JavaScript"). Without the AI, the card's tags are
// compared with your skills by name.
async function scoreSkills(job, mySkills) {
  try {
    const raw = await callAI(`You screen Naukri job listings for a candidate.

Job title: ${job.title}
Key skills on the listing: ${job.tags.join(", ") || "(none)"}
Description: ${job.description || "(none)"}

Candidate's skills: ${mySkills.join(", ")}

1. "jobSkills": the technical skills/tools this job actually needs (at most 10), taken from
   the title, key skills and description. Include the core skill implied by the title
   (e.g. "Manual Testing" for a QA Tester role, "Salesforce" for a Salesforce Developer).
2. "matched": the items of jobSkills the candidate has, copied exactly as written in
   jobSkills. Count the same skill under another name as a match (ReactJS = React,
   JS = JavaScript, Node = Node.js), but not a different technology (Selenium is not
   JavaScript, Angular is not React).
Reply as JSON: {"jobSkills": [...], "matched": [...]}`, { json: true });
    const data = JSON.parse(raw.replace(/^```(json)?|```$/g, "").trim());
    const jobSkills = [...new Set((data.jobSkills || []).filter(s => typeof s === "string" && s.trim()))];
    const key = (s) => String(s).toLowerCase().trim();
    const matchedKeys = new Set((data.matched || []).map(key));
    const matched = jobSkills.filter(s => matchedKeys.has(key(s)));
    return { jobSkills, matched };
  } catch (error) {
    log(`  (AI skill check failed: ${error.message}; comparing tags by name)`);
    const mine = mySkills.map(s => normalize(s).trim());
    const jobSkills = [...new Set(job.tags.filter(Boolean))];
    const matched = jobSkills.filter(tag => mine.includes(normalize(tag).trim()));
    return { jobSkills, matched };
  }
}

// "Just Now" / "Few Hours Ago" -> 0, "3 Days Ago" -> 3, "30+ Days Ago" -> 31,
// "2 Weeks Ago" -> 14, "1 Month Ago" -> 30. Unknown -> null.
function parsePostedDays(text) {
  const t = (text || "").toLowerCase();
  let m;
  if (/just now|today|hour|minute|few/.test(t)) return 0;
  if ((m = t.match(/(\d+)(\+?)\s*day/))) return +m[1] + (m[2] ? 1 : 0);
  if ((m = t.match(/(\d+)\s*week/))) return +m[1] * 7;
  if ((m = t.match(/(\d+)\s*month/))) return +m[1] * 30;
  return null;
}

// "3 Years" -> 3, "2.5" -> 2.5
function parseYears(text) {
  const m = String(text || "").match(/\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

// "2-5 Yrs" -> {2,5}, "5+ Yrs" -> {5,∞}, "Fresher" -> {0,1}
function parseExpRange(text) {
  const t = (text || "").toLowerCase();
  let m;
  if ((m = t.match(/(\d+)\s*-\s*(\d+)/))) return { min: +m[1], max: +m[2], label: `${m[1]}-${m[2]} yrs` };
  if ((m = t.match(/(\d+)\s*\+/))) return { min: +m[1], max: Infinity, label: `${m[1]}+ yrs` };
  if (/fresher/.test(t)) return { min: 0, max: 1, label: "fresher" };
  if ((m = t.match(/(\d+)/))) return { min: +m[1], max: +m[1], label: `${m[1]} yrs` };
  return null;
}

const splitList = (text) => (text || "").split(',').map(s => s.trim()).filter(Boolean);

// ---------- Navigation ----------

// One search for every role and location, the way Naukri's own search bar sends
// several keywords: ".../frontend-developer-react-developer-jobs-in-hyderabad-bangalore?k=...".
function buildNaukriSearchUrl(roles, locations, years, jobAge) {
  const slug = (list) => list.join(" ").toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const params = new URLSearchParams({ k: roles.join(", "), l: locations.join(", ") });
  if (years != null) params.set("experience", Math.floor(years));
  if (jobAge) params.set("jobAge", jobAge); // Naukri's "Freshness" filter, in days
  return `https://www.naukri.com/${slug(roles)}-jobs-in-${slug(locations)}?${params}`;
}

// ".../react-developer-jobs-in-hyderabad-secunderabad?k=..." -> "...-secunderabad-2?k=..."
function withPageNumber(url, page) {
  const u = new URL(url);
  u.pathname = `${u.pathname.replace(/-\d+$/, "")}-${page}`;
  return u.toString();
}

// Loads url in the tab and returns the URL it ended up on after any redirects.
async function navigate(tabId, url) {
  const loaded = waitForTabLoad(tabId);
  await chrome.tabs.update(tabId, { url });
  await loaded;
  await delay(3000); // let dynamic job listings render
  return (await chrome.tabs.get(tabId)).url;
}

// Opens a job page in a background tab, asks content.js there to apply, then closes the tab.
// For "Apply on company site" jobs, returns { status: "external", companyWebsite }.
async function scanResults(tabId) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { action: "SCAN_RESULTS" });
      if (!Array.isArray(response?.jobs)) throw new Error("results page returned no job list");
      return response.jobs;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        log(`Results scan failed (attempt ${attempt}/3): ${error.message}; retrying...`);
        await delay(1000);
      }
    }
  }
  throw new Error(`results scan failed after 3 attempts: ${lastError?.message || "no response"}`);
}

async function applyInNewTab(url) {
  // The tab is opened in front: Chrome holds back background tabs (no focus, paused
  // rendering), which stops typing from registering and Naukri's Save from turning active.
  const tab = await chrome.tabs.create({ url, active: true });
  try {
    await waitForTabLoad(tab.id);
    await delay(2000);
    // Naukri often leaves the job page after Apply or the last answer (e.g. to its
    // "applied" / similar-jobs page). That destroys the page script, so the message fails
    // even though the application went through: verify it instead of dropping the job.
    const result = await chrome.tabs.sendMessage(tab.id, { action: "APPLY_ON_JOB_PAGE" })
      .then(res => res || { status: "unconfirmed", reason: "no answer from the job page" })
      .catch(error => ({ status: "unconfirmed", reason: `job page changed during apply (${error.message})` }));
    if (result.status === "external") {
      // Empty if the careers page couldn't be captured (the Naukri link is in its own column).
      result.companyWebsite = (await findCompanySiteUrl(tab.id)) || "";
    }

    // Naukri often submits without showing a success message where we look for it. Before
    // calling it a failure, open the job page again: it shows "Applied" if it went through.
    if (result.status === "failed" || result.status === "unconfirmed") {
      const landedUrl = (await chrome.tabs.get(tab.id).catch(() => null))?.url || "";
      if (/naukri\.com\/(myapply|.*saveApply|.*apply-?confirmation)/i.test(landedUrl)) {
        return { ...result, status: "applied", reason: "Naukri showed its applied page" };
      }
      // The page the tab landed on may itself show "Applied successfully - We have sent
      // your application to ...".
      await waitForTabLoad(tab.id, 8000).catch(() => {});
      const landed = await chrome.tabs.sendMessage(tab.id, { action: "IS_SUCCESS_PAGE" }).catch(() => null);
      if (landed?.applied) {
        return { ...result, status: "applied", reason: "Naukri showed 'Applied successfully'" };
      }

      const loaded = waitForTabLoad(tab.id);
      await chrome.tabs.update(tab.id, { url }); // back to the job page, wherever the tab went
      await loaded.catch(() => {});
      await delay(2500);
      const check = await chrome.tabs.sendMessage(tab.id, { action: "CHECK_APPLIED" }).catch(() => null);
      if (result.debug) result.debug.afterReloadHeaderHtml = check?.headerHtml || "(no response)";
      if (check?.applied) {
        // Naukri had already counted the application (often on clicking Apply); the stuck
        // question was an extra recruiter question. Keep it in the reason.
        return { ...result, status: "applied", reason: `confirmed on job page${result.reason ? ` (${result.reason})` : ""}` };
      }
      if (landedUrl && landedUrl.split("?")[0] !== url.split("?")[0]) {
        result.reason = `${result.reason || "not confirmed"}; tab had moved to ${landedUrl.slice(0, 150)}`;
      }
    }
    return result;
  } finally {
    await detachDebugger(tab.id);
    await chrome.tabs.remove(tab.id).catch(() => {});
    if (logTabId) chrome.tabs.update(logTabId, { active: true }).catch(() => {});
  }
}

// Clicks "Apply on company site" and captures where it leads: usually a new tab,
// sometimes the same tab. Returns null if nothing opened.
async function findCompanySiteUrl(jobTabId) {
  const { windowId } = await chrome.tabs.get(jobTabId);
  const openedTab = new Promise(resolve => {
    const timer = setTimeout(() => {
      chrome.tabs.onCreated.removeListener(listener);
      resolve(null);
    }, 10000);
    // Naukri may open the careers page with "noopener", which leaves openerTabId empty,
    // so also accept a new tab with no opener in the same window right after the click.
    function listener(newTab) {
      if (newTab.openerTabId === jobTabId || (newTab.openerTabId == null && newTab.windowId === windowId)) {
        clearTimeout(timer);
        chrome.tabs.onCreated.removeListener(listener);
        resolve(newTab);
      }
    }
    chrome.tabs.onCreated.addListener(listener);
  });

  await chrome.tabs.sendMessage(jobTabId, { action: "CLICK_COMPANY_SITE" }).catch(() => {});
  const newTab = await openedTab;

  if (newTab) {
    // Naukri usually goes through a redirect page first; wait (up to 15s) until the tab
    // leaves naukri.com, so we get the real careers page URL.
    const offNaukri = (url) => url && /^https?:/.test(url) && !/(^|\.)naukri\.com\//.test(new URL(url).hostname + "/");
    let finalUrl = null;
    for (let waited = 0; waited < 15000; waited += 500) {
      const t = await chrome.tabs.get(newTab.id).catch(() => null);
      if (!t) break;
      finalUrl = t.url || t.pendingUrl || finalUrl;
      if (offNaukri(finalUrl) && t.status === "complete") break;
      await delay(500);
    }
    chrome.tabs.remove(newTab.id).catch(() => {});
    return offNaukri(finalUrl) ? finalUrl : null;
  }

  const sameTabUrl = (await chrome.tabs.get(jobTabId).catch(() => null))?.url;
  return sameTabUrl && !sameTabUrl.includes("naukri.com") ? sameTabUrl : null;
}

function waitForTabLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("page took too long to load"));
    }, timeoutMs);

    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function recordApplication(job, matchReason, { status, companyWebsite = "", timeTakenMs = null }) {
  const { appliedJobs: stored = [] } = await chrome.storage.local.get('appliedJobs');
  // One row per job: a re-checked job replaces its old row instead of duplicating it.
  const appliedJobs = stored.filter(j => j.url !== job.url);
  appliedJobs.push({
    url: job.url,
    companyName: job.company || "Unknown",
    role: job.title,
    experience: job.experience || "",
    status,
    companyWebsite,
    description: `Matched: ${matchReason}`,
    timeTaken: timeTakenMs == null ? "" : formatDuration(timeTakenMs),
    appliedDate: new Date().toLocaleDateString(),
    appliedTime: new Date().toLocaleTimeString("en-GB")
  });
  await chrome.storage.local.set({ appliedJobs });
}

const delay = (ms) => new Promise(res => setTimeout(res, ms));

// ---------- Groq ----------

// Sends one prompt to Groq (OpenAI-compatible chat API). json: true asks for a JSON reply.
async function callAI(prompt, { json = false } = {}) {
  let lastError = "Groq API request failed";

  for (const model of GROQ_MODELS) {
    const body = { model, temperature: 0, messages: [{ role: "user", content: prompt }] };
    if (json) body.response_format = { type: "json_object" };

    let response, data;
    try {
      response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000)
      });
      data = await response.json().catch(() => ({}));
    } catch (error) {
      lastError = `${model}: ${error.name === "TimeoutError" ? "timed out" : error.message}`;
      continue;
    }

    if (response.ok) {
      const text = data.choices?.[0]?.message?.content || "";
      return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim(); // drop any visible reasoning
    }

    lastError = `${model}: ${data.error?.message || `HTTP ${response.status}`}`;
    // Rate-limited / overloaded / model unavailable: try the next model. Anything else
    // (bad key, bad request) won't be fixed by another model.
    if (![404, 429, 498, 500, 502, 503].includes(response.status)) break;
  }
  throw new Error(lastError);
}

// Fixes typos in the search roles and cities ("hyderbad" -> "Hyderabad", "banglore" ->
// "Bangalore") and saves the corrected values to the profile. Keeps them as typed if
// the AI can't be reached.
async function correctSearchTerms(roles, locations) {
  let fixed;
  try {
    const raw = await callAI(`Correct the spelling of these job-search terms for Naukri.com (India).
Fix typos only: keep each role's meaning and each city as the user intended, use the
common spelling Naukri uses for Indian cities (e.g. "Bangalore", "Hyderabad", "Gurgaon").
Keep the same number of items, in the same order.
Reply as JSON: {"roles": [...], "locations": [...]}

roles: ${JSON.stringify(roles)}
locations: ${JSON.stringify(locations)}`, { json: true });
    fixed = JSON.parse(raw.replace(/^```(json)?|```$/g, "").trim());
  } catch (error) {
    log(`Couldn't check spelling of roles/locations (${error.message}); searching as typed.`);
    return { roles, locations };
  }

  const pick = (original, corrected) =>
    Array.isArray(corrected) && corrected.length === original.length && corrected.every(c => typeof c === "string" && c.trim())
      ? corrected.map(c => c.trim())
      : original;
  const result = { roles: pick(roles, fixed.roles), locations: pick(locations, fixed.locations) };

  const changes = [...roles.map((r, i) => [r, result.roles[i]]), ...locations.map((l, i) => [l, result.locations[i]])]
    .filter(([before, after]) => before !== after);
  if (changes.length) {
    log(`Corrected spelling: ${changes.map(([b, a]) => `"${b}" → "${a}"`).join(", ")}`);
    const { userProfile = {} } = await chrome.storage.local.get('userProfile');
    await chrome.storage.local.set({ userProfile: {
      ...userProfile, targetRole: result.roles.join(", "), targetLocation: result.locations.join(", ")
    } });
  }
  return result;
}

// Takes the resume text (pulled out of the PDF by popup.js), stores it for answering
// screening questions, and saves the details read from it. CTC, notice period etc. are
// left for the user.
async function extractProfileFromResume(resumeText) {
  if (!resumeText || resumeText.trim().length < 50) {
    throw new Error("Couldn't read any text from this PDF (is it a scanned image?).");
  }
  const today = new Date().toISOString().slice(0, 10);
  const raw = await callAI(`Today is ${today}. Read this resume and return a JSON object with exactly these string keys ("" if not found):
- "totalExp": total professional experience, e.g. "3.5 Years". Add up the job dates up to today; ignore internships unless that is all there is.
- "skills": 5 to 8 core technical skills (languages, frameworks, libraries), comma separated, e.g. "React, JavaScript, TypeScript, Redux". Leave out basics and general tools such as HTML, CSS, REST APIs, Git, Jira, VS Code, MS Office (they would match almost every job).
- "targetRole": 2 or 3 job titles this person fits, comma separated.
- "currentLocation": the city they live or work in.
- "dob": date of birth as DD/MM/YYYY, only if the resume states it.
- "languages": spoken languages listed, comma separated.
- "linkedin": LinkedIn profile URL.
- "portfolio": GitHub or portfolio URL.
- "currentCompany": most recent employer.
- "currentDesignation": most recent job title.
- "summary": 2 to 3 lines describing their experience, also naming tools and practices the resume shows, such as Git, REST APIs, testing, CI/CD, production deployments.
Use only what the resume says. Do not invent anything.

Resume:
"""
${resumeText}
"""`, { json: true });

  let data;
  try {
    data = JSON.parse(raw.replace(/^```(json)?|```$/g, "").trim());
  } catch {
    throw new Error("The AI's reply wasn't valid JSON. Try uploading again.");
  }

  const { userProfile = {} } = await chrome.storage.local.get('userProfile');
  const merged = { ...userProfile };

  // The resume is the source for these (replacing any older values)...
  for (const key of ["totalExp", "skills", "currentCompany", "currentDesignation", "currentLocation", "summary"]) {
    merged[key] = data[key] || "";
  }
  // ...but roles and locations are your search preferences, so only fill them if empty.
  if (!merged.targetRole && data.targetRole) merged.targetRole = data.targetRole;
  if (!merged.targetLocation && data.currentLocation) merged.targetLocation = data.currentLocation;
  // These are typed fields; fill them from the resume only if they're empty.
  for (const key of ["dob", "languages", "linkedin", "portfolio"]) {
    if (!merged[key] && data[key]) merged[key] = data[key];
  }

  await chrome.storage.local.set({ userProfile: merged, resumeText: resumeText.trim(), answerCache: {} });
  return merged;
}

// Labels for every saved profile field passed to the AI (empty fields are left out).
const PROFILE_LABELS = {
  targetRole: "Roles", totalExp: "Total Experience", skills: "Key Skills",
  currentCompany: "Current Company", currentDesignation: "Current Designation",
  currentLocation: "Current City", targetLocation: "Preferred Locations",
  currentCTC: "Current CTC", expectedCTC: "Expected CTC", fixedSalary: "Current Fixed Salary",
  noticePeriod: "Notice Period", noticeNegotiable: "Notice Period Negotiable",
  employmentStatus: "Employment Status", lastWorkingDate: "Last Working Date",
  competingOffers: "Competing Offers", reasonForChange: "Reason for Job Change",
  dob: "Date of Birth", gender: "Gender", maritalStatus: "Marital Status", hometown: "Hometown",
  languages: "Languages Known", passport: "Valid Passport", careerGap: "Career Gap",
  willingToRelocate: "Willing to Relocate", workMode: "Preferred Work Mode",
  workFromOffice: "Comfortable Working from Office", shifts: "Comfortable with Night/Rotational Shifts",
  travel: "Willing to Travel", tenthScore: "10th Score", twelfthScore: "12th/Diploma Score",
  gradScore: "Graduation Score", linkedin: "LinkedIn", portfolio: "GitHub/Portfolio"
};

function profileLines(profile) {
  return Object.entries(PROFILE_LABELS)
    .filter(([key]) => profile[key])
    .map(([key, label]) => `- ${label}: ${profile[key]}`)
    .join("\n");
}

async function handleAIAnswerGeneration({
  question, options = [], multi = false, inputType = "text", jobTitle, earliestJoiningDate, previous = []
}) {
  const storageData = await chrome.storage.local.get(['userProfile', 'resumeText', 'answerCache']);
  const profile = storageData.userProfile || {};
  const resume = storageData.resumeText || "(no resume uploaded)";

  // Reuse answers to questions seen before, to save requests (Groq's free tier allows
  // 1,000 requests/day and 8,000 tokens/minute). Cleared whenever the profile or resume changes.
  const cache = storageData.answerCache || {};
  const cacheKey = [question.toLowerCase().replace(/\s+/g, " ").trim(), options.join("|"), multi, inputType].join("::");
  if (cache[cacheKey]) return cache[cacheKey];
  const today = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

  let answerFormat;
  if (options.length && multi) {
    answerFormat = `This is a multi-select question. Reply with every option that applies, copied word for word, separated by " | ". Options:\n${options.map(o => `- ${o}`).join("\n")}`;
  } else if (options.length) {
    answerFormat = `This is a multiple-choice question. Reply with EXACTLY one of these options, copied word for word:\n${options.map(o => `- ${o}`).join("\n")}`;
  } else if (inputType === "number") {
    answerFormat = `The answer box takes a number. Reply with only the number (e.g. "3", "15", "30"), no units.`;
  } else {
    answerFormat = `Reply with just the answer, as the candidate would type it:
- Yes/No questions: only "Yes" or "No".
- Dates: DD/MM/YYYY.
- Amounts, durations, names, cities, links: just the value (e.g. "15 LPA", "30 Days", "Hyderabad").
- Open-ended questions (describe, why, explain): 2 to 3 confident first-person sentences.`;
  }

  const earlier = previous.length
    ? `\nEarlier questions in this application:\n${previous.map(p => `- Q: ${p.question}\n  A: ${p.answer}`).join("\n")}\n`
    : "";

  const prompt = `
You are answering a Naukri job application screening question on behalf of the candidate. Job: "${jobTitle}".

First work out what the question is really asking, even if it is worded unusually, abbreviated (DOB, CTC, NP, LWD, WFO) or has typos. Then answer it from the candidate's data below.

Facts:
- Today's date: ${today}
- Earliest joining date: ${earliestJoiningDate || "Not specified"}

Candidate's own answers (highest priority):
${profileLines(profile) || "(none)"}

Candidate's resume:
"""
${resume}
"""
${earlier}
Question: "${question}"

How to answer:
- Use the candidate's own answers first; they override the resume (CTC, notice period, employment status, personal details, preferences, scores, links).
- Use the resume for skills, tools, projects, education, companies, designations and years of experience.
- Years with a skill: work it out from the resume's job dates where that skill was used; if unclear but the skill appears in the resume, use Total Experience. If the skill is not in the resume, the answer is 0 (or "No").
- Never invent facts. If the data truly doesn't cover the question, give the most neutral honest answer ("No", "0" or "Not applicable").
- Stay consistent with the earlier answers in this application.

${answerFormat}
Output only the answer: no quotes, labels, explanation or markdown.
`;

  const answer = await callAI(prompt);
  if (answer) {
    cache[cacheKey] = answer;
    await chrome.storage.local.set({ answerCache: cache });
  }
  return answer;
}
