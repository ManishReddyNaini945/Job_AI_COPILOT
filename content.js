// content.js - Page-side helper for the background.js orchestrator
//
// On a Naukri results page: SCAN_RESULTS returns the job cards' details.
// On a job page (opened in a background tab): APPLY_ON_JOB_PAGE clicks Apply, answers
// the screening questions (Naukri's chatbot drawer or a plain form) and confirms success.

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "SCAN_RESULTS") {
    scanResults().then(jobs => sendResponse({ jobs }));
    return true; // async response
  }
  if (request.action === "APPLY_ON_JOB_PAGE") {
    applyOnJobPage().then(sendResponse);
    return true;
  }
  if (request.action === "CHECK_APPLIED") {
    // After a reload: wait for the page to show either "Applied" or a fresh Apply button.
    // Applied = the page shows "Applied" AND there is no Apply button left.
    waitFor(() => {
      if (findApplyButton() || findCompanySiteButton()) return "no";
      return jobHeaderShowsApplied() || pageShowsApplied() ? "yes" : null;
    }, 8000).then(state => sendResponse({ applied: state === "yes", headerHtml: jobHeaderSnapshot() }));
    return true;
  }
  if (request.action === "CLICK_COMPANY_SITE") {
    // A real click: Chrome's pop-up blocker stops script clicks from opening the careers tab.
    const btn = findCompanySiteButton();
    (btn ? realClick(btn) : Promise.resolve()).then(() => sendResponse({ ok: !!btn }));
    return true;
  }
  if (request.action === "LOG") {
    console.log("[Job AI Co-Pilot]", request.text);
  }
  if (request.action === "SHOW_ALERT") {
    sendResponse({ ok: true });
    setTimeout(() => alert(`Job AI Co-Pilot\n\n${request.text}`), 0); // after replying, so the alert doesn't block it
  }
});

async function scanResults() {
  // Listings render after page load; wait up to ~10s for them.
  let cards = [];
  for (let i = 0; i < 20 && cards.length === 0; i++) {
    cards = [...document.querySelectorAll('.srp-jobtuple-wrapper, article.jobTuple, .cust-job-tuple')];
    if (cards.length === 0) await delay(500);
  }

  const text = (card, selector) => card.querySelector(selector)?.innerText.trim() || "";

  return cards
    .map(card => {
      const titleEl = card.querySelector('a.title, .title a, a[class*="title"]');
      return {
        url: titleEl?.href || "",
        title: titleEl?.innerText.trim() || "",
        company: text(card, '.comp-name, .companyInfo a, [class*="comp-name"]'),
        experience: text(card, '.exp-wrap, .expwdth, .exp, [class*="exp-wrap"]'),
        location: text(card, '.loc-wrap, .locWdth, .loc, [class*="loc-wrap"]'),
        tags: [...card.querySelectorAll('ul.tags-gt li, .tags li, [class*="tags"] li')].map(li => li.innerText.trim()),
        description: text(card, '.job-desc, [class*="job-desc"]'),
        posted: text(card, '.job-post-day, [class*="job-post-day"], [class*="post-day"]')
      };
    })
    .filter(job => job.url && job.title);
}

// ---------- Applying on the job page ----------

// Returns { status: "applied" | "unconfirmed" | "failed" | "external" | "skipped", reason?, answers? }
async function applyOnJobPage() {
  const stored = await chrome.storage.local.get(['userProfile', 'resumeText']);
  const userProfile = { ...(stored.userProfile || {}), resumeText: stored.resumeText || "" };

  // Job pages render late; wait up to ~10s for an Apply / Apply on company site button.
  let applyBtn = null;
  // A direct Naukri Apply always wins; only fall back to company site if that's the sole option.
  for (let i = 0; i < 20 && !applyBtn; i++) {
    applyBtn = findApplyButton();
    if (applyBtn) break;
    if (findCompanySiteButton()) return { status: "external" }; // background.js grabs the URL
    await delay(500);
  }

  if (!applyBtn) {
    if (isApplySuccess()) return { status: "skipped", reason: "already applied" };
    return { status: "skipped", reason: "no Apply button found" };
  }

  await realClick(applyBtn);

  // Either it applies straight away, or a question drawer / form opens.
  await waitFor(() => isApplySuccess() || getChatbot() || hasVisibleFormInputs(), 8000);

  const answers = [];
  if (!isApplySuccess()) {
    if (getChatbot()) {
      const outcome = await answerChatbot(userProfile, answers);
      if (!outcome.ok) return { status: "failed", reason: outcome.reason, answers, debug: debugSnapshot(outcome.reason, answers) };
    } else if (hasVisibleFormInputs()) {
      await fillScreeningForms(userProfile, answers);
    }
  }

  const confirmed = await waitFor(isApplySuccess, 8000);
  return confirmed
    ? { status: "applied", answers }
    : { status: "unconfirmed", reason: "no 'successfully applied' message seen", answers };
}

// Only visible, enabled buttons count: Naukri can keep both buttons in the page and
// hide the one that doesn't apply to this job.
function findApplyButton() {
  // After applying, Naukri keeps the same #apply-button and only changes its text to
  // "Applied", so the text must still say Apply.
  const byId = [...document.querySelectorAll('#apply-button, .jobs-apply-button')]
    .find(b => !b.disabled && isVisible(b) && /^(easy\s+)?apply( now)?$/i.test(b.innerText.trim()));
  if (byId) return byId;

  // Match a button whose text is exactly "Apply" / "Easy Apply" (not "Apply on company site").
  return [...document.querySelectorAll('button')].find(
    b => !b.disabled && isVisible(b) && /^(easy\s+)?apply( now)?$/i.test(b.innerText.trim())
  ) || null;
}

function findCompanySiteButton() {
  // Exact text match only, so "Similar jobs" cards mentioning it don't count.
  return [...document.querySelectorAll('#company-site-button, button, a')].find(
    b => isVisible(b) && (b.id === 'company-site-button' || /^apply on company (site|website)$/i.test(b.innerText.trim()))
  ) || null;
}

function isApplySuccess() {
  if (/successfully applied|applied successfully|application (has been )?(sent|submitted)/i.test(document.body.innerText)) {
    return true;
  }
  return [...document.querySelectorAll('#already-applied, button')].some(
    b => /^applied$/i.test(b.innerText.trim())
  );
}

// Looser check used after a reload (only when no Apply button is visible): "already
// applied" text, or an element styled as the apply button now reading "Applied".
function pageShowsApplied() {
  if (/already applied|successfully applied|applied successfully/i.test(document.body.innerText)) return true;
  return [...document.querySelectorAll('#already-applied, [id*="already-applied"], button, [class*="apply" i]')]
    .some(el => isVisible(el) && /^applied$/i.test(el.innerText.trim()));
}

// HTML around the job title and its buttons, for the debug info.
function jobHeaderSnapshot() {
  let box = document.querySelector('h1');
  for (let depth = 0; box && depth < 6 && !box.querySelector('button'); depth++) box = box.parentElement;
  if (!box) return "(job header not found)";
  const copy = box.cloneNode(true);
  copy.querySelectorAll('script, style, svg, img').forEach(el => el.remove());
  return copy.outerHTML.replace(/\s{2,}/g, " ").slice(0, 15000);
}

// After a reload: does THIS job's header show "Applied"? Only the area around the job
// title (h1) counts, so "Applied" tags on similar-job cards elsewhere are ignored.
function jobHeaderShowsApplied() {
  const byId = document.querySelector('#already-applied');
  if (byId && isVisible(byId)) return true;

  let box = document.querySelector('h1');
  for (let depth = 0; box && depth < 6; depth++, box = box.parentElement) {
    const applied = [...box.querySelectorAll('button, a, span, div')].some(el =>
      el.children.length === 0 && isVisible(el) && /^applied$/i.test(el.innerText.trim()));
    if (applied) return true;
    if (box.querySelector('#apply-button, #company-site-button, button')) break; // reached the button row
  }
  return false;
}

// ---------- Naukri chatbot questions ----------

// Naukri's question drawer is found by what it shows (the "Type message here..." box,
// answer options, a Save button), not only by class names, which Naukri changes.
const CHATBOT_CLASS_SELECTOR = '[class*="chatbot" i]';
const MESSAGE_BOX_SELECTOR = '[contenteditable="true"], [placeholder*="type message" i], [data-placeholder*="type message" i]';

function getChatbot() {
  // 1. By class name: the outermost visible "chatbot" element that holds a message box or
  //    answer options (so a floating help icon doesn't count).
  const byClass = [...document.querySelectorAll(CHATBOT_CLASS_SELECTOR)].filter(el =>
    isVisible(el) && el.querySelector(`${MESSAGE_BOX_SELECTOR}, input[type="radio"], input[type="checkbox"], [class*="chip" i]`)
  );
  const outer = byClass.find(el => !byClass.some(other => other !== el && other.contains(el)));
  if (outer) return outer;

  // 2. By the message box: climb up until the container also holds the Save button.
  const box = [...document.querySelectorAll(MESSAGE_BOX_SELECTOR)].find(isVisible);
  if (!box) return null;
  let el = box;
  for (let i = 0; i < 12 && el.parentElement; i++) {
    el = el.parentElement;
    if (findSaveButton(el)) return el;
  }
  return box.parentElement;
}

// The latest question in the drawer. givenAnswers are skipped, since our own replies
// show up as chat bubbles too.
function lastBotQuestion(bot, givenAnswers = []) {
  const msgs = bot.querySelectorAll('.botMsg, [class*="botMsg"], li.botItem, [class*="botItem"]');
  if (msgs.length) return msgs[msgs.length - 1].innerText.trim();

  // Fallback: the last visible text block in the drawer that isn't the input box, an
  // answer option, a button, or one of our replies.
  const replies = new Set(givenAnswers.map(a => a.trim().toLowerCase()));
  const texts = [...bot.querySelectorAll('div, span, p, li')]
    .filter(el => el.children.length === 0 && isVisible(el) &&
      !el.closest(`${MESSAGE_BOX_SELECTOR}, label, [class*="chip" i], button`))
    .map(el => el.innerText.trim())
    .filter(t => t.length > 3 && !replies.has(t.toLowerCase()) &&
      !/^(save|submit|send|next|skip|type message)/i.test(t));
  return texts[texts.length - 1] || "";
}

// The deepest visible element whose text is exactly Save / Submit / Send / Next.
function findSaveButton(scope) {
  const candidates = [...scope.querySelectorAll('button, [role="button"], div, span, a')]
    .filter(el => isVisible(el) && /^(save|submit|send|next)$/i.test(el.innerText.trim()));
  return scope.querySelector('.sendMsg, [class*="sendMsg"]') ||
    candidates.find(el => !candidates.some(other => other !== el && el.contains(other))) ||
    null;
}

// Answers the drawer's questions one by one until it closes or reports success.
async function answerChatbot(profile, answers) {
  const given = () => answers.map(a => a.answer);

  for (let step = 0; step < 20; step++) {
    if (isApplySuccess()) return { ok: true };

    const bot = getChatbot();
    if (!bot) return { ok: true }; // drawer closed: questions finished

    const question = await waitFor(() => lastBotQuestion(getChatbot() || document.body, given()), 5000);
    if (!question) return { ok: false, reason: "couldn't read the question" };

    const answered = await answerOneQuestion(bot, question, profile, answers);
    if (!answered) {
      const why = lastAIError ? ` (AI: ${lastAIError})` : "";
      return { ok: false, reason: `couldn't answer: "${question.slice(0, 80)}"${why}` };
    }

    // Wait for the next question, the drawer to close, or success.
    const movedOn = () => {
      const b = getChatbot();
      return isApplySuccess() || !b || lastBotQuestion(b, given()) !== question;
    };
    let moved = await waitFor(movedOn, 6000);
    if (!moved && getChatbot()) {
      // Not accepted yet: submit again (Save or Enter) and give it a bit longer.
      await submitAnswer(getChatbot());
      moved = await waitFor(movedOn, 6000);
    }
    if (!moved) {
      const state = getChatbot() ? ` [${describeDrawer(getChatbot())}]` : "";
      return { ok: false, reason: `stuck on: "${question.slice(0, 80)}"${state}` };
    }

    await delay(800);
  }
  return { ok: false, reason: "too many questions" };
}

async function answerOneQuestion(bot, question, profile, answers) {
  const options = getChoiceOptions(bot);

  if (options.length) {
    const isMulti = options.some(o => o.el.type === "checkbox");
    let picks = [];

    // 1. Built-in rules (free, instant) when they recognise the question.
    if (!isMulti) {
      const pick = matchOption(options, ruleAnswer(question, profile));
      if (pick) picks = [pick];
    }

    // 2. Otherwise the AI reads the question and picks from the options using your data.
    if (!picks.length) {
      const aiAnswer = await requestAIAnswer(question, profile, answers, {
        options: options.map(o => o.label), multi: isMulti
      });
      if (aiAnswer) {
        const wanted = isMulti ? aiAnswer.split("|").map(a => a.trim()) : [aiAnswer];
        picks = [...new Set(wanted.map(w => matchOption(options, w)).filter(Boolean))];
      }
    }

    // 3. Last resort for multi-select: tick the options that match your skills.
    if (!picks.length && isMulti) {
      const skills = splitList(profile.skills).map(s => s.toLowerCase());
      picks = options.filter(o => skills.some(s => o.label.toLowerCase().includes(s)));
    }
    if (!picks.length) return false;

    for (const option of picks) await selectOption(option);
    answers.push({ question, answer: picks.map(o => o.label).join(", ") });
  } else {
    const input = bot.querySelector('[contenteditable="true"], input[type="text"], input[type="number"], input[type="tel"], textarea');
    if (!input) return false;

    const wantsNumber = input.type === "number" || /in lakhs|in lpa|in days|number of|how many/i.test(question);
    // Built-in rules first (free, instant); the AI for anything they don't recognise.
    let answer = ruleAnswer(question, profile) ||
      await requestAIAnswer(question, profile, answers, { inputType: wantsNumber ? "number" : "text" });
    if (!answer) return false;
    if (wantsNumber) {
      answer = (answer.match(/\d+(\.\d+)?/) || [answer])[0]; // "15 LPA" -> "15"
    }

    await setInputValue(input, answer);
    answers.push({ question, answer });
  }

  await submitAnswer(bot);
  return true;
}

// Clicks Save once it turns active (it stays grey until Naukri registers the typing).
// Falls back to pressing Enter in the message box.
async function submitAnswer(bot) {
  const saveBtn = await waitFor(() => {
    const btn = findSaveButton(bot) || findSaveButton(document.body);
    return btn && isEnabled(btn) ? btn : null;
  }, 4000);

  if (saveBtn) {
    await realClick(saveBtn);
  } else {
    const box = bot.querySelector(MESSAGE_BOX_SELECTOR);
    if (box) await pressEnter(box);
  }
}

// The question drawer's HTML (scripts/styles stripped, capped in size) plus context, so a
// stuck question can be diagnosed. Saved by background.js; copied from the popup.
function debugSnapshot(reason, answers) {
  const bot = getChatbot();
  let html = "(question drawer not found)";
  if (bot) {
    const copy = bot.cloneNode(true);
    copy.querySelectorAll('script, style, svg, img').forEach(el => el.remove());
    html = copy.outerHTML.replace(/\s{2,}/g, " ").slice(0, 30000);
  }
  return { reason, url: location.href, answers, drawerHtml: html, capturedAt: new Date().toISOString() };
}

// Selects a radio/checkbox/chip the way a person does: clicks the visible label (often the
// hidden input itself isn't what the page listens to), then makes sure it ended up checked.
async function selectOption({ el, labelEl }) {
  await realClick(labelEl && labelEl !== el && isVisible(labelEl) ? labelEl : el);
  await delay(300);
  if ((el.type === "radio" || el.type === "checkbox") && !el.checked) {
    await realClick(el);
    await delay(300);
    if (!el.checked) {
      el.checked = true;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
}

// What the drawer looks like right now, for the "stuck" log line.
function describeDrawer(bot) {
  const box = bot.querySelector(MESSAGE_BOX_SELECTOR);
  const btn = findSaveButton(bot) || findSaveButton(document.body);
  const typed = box ? (box.isContentEditable ? box.innerText : box.value).trim() : null;
  const options = getChoiceOptions(bot);
  const checked = options.filter(o => o.el.checked).map(o => o.label);
  return `box ${box ? `has "${typed}"` : "not found"}, ` +
    (options.length ? `${options.length} options (${checked.length ? `checked: ${checked.join(", ")}` : "none checked"}), ` : "") +
    `Save ${btn ? (isEnabled(btn) ? "active" : "still grey/disabled") : "not found"}`;
}

function isEnabled(el) {
  for (let node = el, i = 0; node && i < 3; node = node.parentElement, i++) {
    if (node.disabled || node.getAttribute('aria-disabled') === 'true' ||
        /\bdisabled\b/i.test(node.className || '') || getComputedStyle(node).pointerEvents === 'none') {
      return false;
    }
  }
  return true;
}

// A full mouse click sequence; some React buttons ignore a bare .click().
// ---------- Real input ----------
// Naukri's React pages ignore script-made events (isTrusted: false): text set by a script
// never reaches React's state, so Save submits an empty answer. background.js sends REAL
// mouse/keyboard input through chrome.debugger instead. If that fails (e.g. DevTools is
// open on the tab), we fall back to script events.

function sendRealInput(input) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action: "REAL_INPUT", ...input }, (res) => {
      resolve(!chrome.runtime.lastError && res?.ok);
    });
  });
}

// Clicks the centre of an element with a real mouse click.
async function realClick(el) {
  el.scrollIntoView({ block: "center", inline: "center" });
  await delay(250);
  const rect = el.getBoundingClientRect();
  const ok = rect.width > 0 && await sendRealInput({
    type: "click",
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2
  });
  if (!ok) syntheticClick(el);
}

function syntheticClick(el) {
  const opts = { bubbles: true, cancelable: true, view: window };
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.click();
}

async function pressEnter(el) {
  await realClick(el); // focus the box
  if (await sendRealInput({ type: "key", key: "Enter" })) return;
  el.focus();
  for (const type of ['keydown', 'keypress', 'keyup']) {
    el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  }
}

function getChoiceOptions(bot) {
  const inputs = [...bot.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
  if (inputs.length) {
    return inputs.map(input => {
      const labelEl = (input.id && bot.querySelector(`label[for="${CSS.escape(input.id)}"]`)) ||
        input.closest('label') || input.parentElement;
      return { label: labelEl?.innerText.trim() || input.value, el: input, labelEl };
    }).filter(o => o.label);
  }
  // Clickable chips (e.g. "Yes" / "No" / "Skip this question")
  return [...bot.querySelectorAll('[class*="chip"], [class*="Chip"]')]
    .filter(isVisible)
    .map(el => ({ label: el.innerText.trim(), el }))
    .filter(o => o.label && !/skip/i.test(o.label));
}

function matchOption(options, wanted) {
  if (!wanted) return null;
  const w = wanted.toLowerCase().trim();
  return options.find(o => o.label.toLowerCase() === w) ||
    options.find(o => o.label.toLowerCase().includes(w)) ||
    options.find(o => w.includes(o.label.toLowerCase())) ||
    null;
}

// Answers common questions straight from the profile; returns null to defer to the AI.
function ruleAnswer(question, profile) {
  // "React.js" / "ReactJS" -> "react", so skills match however they're written
  const norm = (s) => s.toLowerCase().replace(/\b(react|node|vue|next|express)\.?js\b/g, "$1");
  const q = norm(question).trim();
  const years = (String(profile.totalExp || "").match(/\d+(\.\d+)?/) || [])[0];
  const skills = splitList(profile.skills).map(norm);
  const roles = splitList(profile.targetRole).map(norm);
  const mentionsYours = [...skills, ...roles].some(s => q.includes(s));
  const status = profile.employmentStatus || "Employed";
  const languages = splitList(profile.languages).map(l => l.toLowerCase());

  // Yes/No questions ("Do you...", "Are you...", "Have you...")
  if (/^(do|does|did|have|has|are|is|can|could|will|would)\b/.test(q)) {
    if (/notice.*(negotiable|buy ?out|reduc|early)|join (early|earlier|sooner|immediately)|early join/.test(q)) {
      return profile.noticeNegotiable || "Yes";
    }
    if (/serving (your |the )?notice/.test(q)) return status === "Serving notice period" ? "Yes" : "No";
    if (/currently (employed|working)/.test(q)) return status === "Not currently working" ? "No" : "Yes";
    if (/competing offer|other offer|offer in hand|any offers?/.test(q)) return profile.competingOffers || "No";
    if (/authori[sz]ed to work|work permit|legally (allowed|eligible)/.test(q)) return "Yes";
    if (/passport/.test(q)) return profile.passport || null;
    // "Are you an ex-Infosys employee? ... If No: Mention NA" -> NA unless the resume shows that company
    const exCompany = q.match(/\bex[- ]?([a-z0-9&.]+) employee|(?:previously|ever|earlier) (?:worked|been employed|been associated) (?:with|at|for|in) ([a-z0-9&.]+)/);
    if (exCompany) {
      const company = exCompany[1] || exCompany[2];
      if (!(profile.resumeText && norm(profile.resumeText).includes(company))) {
        return /\bna\b|n\/a/.test(q) ? "NA" : "No";
      }
      return null; // you did work there: the AI handles details like the employee ID
    }
    if (/\bgap\b|break in (your )?(career|employment)/.test(q)) return profile.careerGap || "No";
    if (/relocat/.test(q)) return profile.willingToRelocate || "Yes";
    if (/night|rotational|shift/.test(q)) return profile.shifts || "Yes";
    if (/travel/.test(q)) return profile.travel || "Yes";
    if (/work(ing)? from (the )?office|\bwfo\b|on-?site|onsite|hybrid|days a week (in|from) (the )?office/.test(q)) {
      return profile.workFromOffice || "Yes";
    }
    if (/remote|work from home|\bwfh\b/.test(q)) {
      return ["Remote", "Any"].includes(profile.workMode || "Any") ? "Yes" : "No";
    }
    if (languages.length && /speak|fluent|language|read and write|communicate in/.test(q) && !/programming|coding|scripting/.test(q)) {
      return languages.some(l => q.includes(l)) ? "Yes" : "No";
    }
    if (/comfortable|open to|negotia|immediate joiner|willing to/.test(q)) return "Yes";
    if (mentionsYours) return "Yes";
    const skill = askedSkill(q);
    if (skill && profile.resumeText) return resumeMentions(profile, skill, norm) ? "Yes" : "No";
    return null; // e.g. "Do you have experience deploying to production?" -> the AI uses the resume
  }

  // Reason for change (before the open-ended check, since it often starts with "Why are you...")
  if (/reason (for|of|behind) (the )?(job |your )?(change|switch|leaving)|why (are you )?(looking|leaving|changing|switching|want to (change|leave|switch))/.test(q)) {
    return profile.reasonForChange || null;
  }

  // Open-ended questions ("Briefly describe...", "Why are you suitable...") need a written answer.
  if (/describe|explain|tell us|tell me|brief|summar|why (are|should|do)/.test(q)) return null;

  // Personal
  if (/date of birth|\bdob\b|birth ?date/.test(q)) return profile.dob || null;
  if (/gender/.test(q)) return profile.gender || null;
  if (/marital/.test(q)) return profile.maritalStatus || null;
  if (/home ?town|native (place|city)|permanent (address|location|city)/.test(q)) return profile.hometown || null;
  if (/language/.test(q) && !/programming|coding|scripting|framework/.test(q)) return profile.languages || null;

  // Education scores (12th before 10th: "class xii" contains "class x")
  if (/12th|twelfth|\bhsc\b|intermediate|class xii|\bpuc\b|diploma/.test(q)) return profile.twelfthScore || null;
  if (/10th|tenth|\bssc\b|class x\b|matriculation|sslc/.test(q)) return profile.tenthScore || null;
  if (/(graduation|degree|b\.?tech|\bb\.?e\b|bachelor|\bug\b|college|university).*(percent|%|cgpa|gpa|marks|score|aggregate)|cgpa/.test(q)) {
    return profile.gradScore || null;
  }

  // Links
  if (/linked ?in/.test(q)) return profile.linkedin || null;
  if (/github|portfolio|personal website|website/.test(q)) return profile.portfolio || null;

  // Salary & joining
  if (/joining date|date of joining|when can you join|earliest.*join/.test(q)) return earliestJoiningDate(profile);
  if (/last working (date|day)/.test(q)) return profile.lastWorkingDate || null;
  if (/notice period|days to join|joining time|how soon can you join/.test(q)) return profile.noticePeriod || null;
  if (/fixed (salary|ctc|pay|component)/.test(q)) return profile.fixedSalary || profile.currentCTC || null;
  if (/expected (ctc|salary|compensation)|\bectc\b/.test(q)) return profile.expectedCTC || null;
  if (/current (ctc|salary|compensation)|\bcctc\b/.test(q)) return profile.currentCTC || null;
  if (/employment status|currently (employed|working)/.test(q)) return status;
  if (/current (company|employer|organi[sz]ation)|company name/.test(q)) return profile.currentCompany || null;
  if (/designation|current (role|position|job title)/.test(q)) return profile.currentDesignation || null;
  if (/work ?mode|work (from|location) preference|prefer(red)? (to )?work (from|mode)/.test(q)) return profile.workMode || "Any";

  if (/experience|how many years|years of/.test(q) && years) {
    if (mentionsYours || /total|overall|relevant|professional|work experience|it experience/.test(q)) return years;
    // "...experience in Spring Boot?": your years if the resume mentions it, otherwise 0.
    const skill = askedSkill(q);
    if (skill && profile.resumeText) return resumeMentions(profile, skill, norm) ? years : "0";
    return null; // a skill you didn't list: let the AI answer honestly
  }

  if (/preferred (job |work )?location/.test(q)) return profile.targetLocation || null;
  if (/current (location|city)|currently located|where are you (based|located)|which city/.test(q)) {
    return profile.currentLocation || splitList(profile.targetLocation)[0] || null;
  }
  return null;
}

// The skill a question asks about: "experience in Spring Boot?" -> "spring boot".
function askedSkill(q) {
  const m = q.match(/(?:experience|worked|work|expertise|knowledge|proficien\w*)(?:\s+\w+){0,4}?\s+(?:in|with|on|using|of)\s+([a-z0-9.+#\/ -]{2,40}?)\s*(?:\?|$|\.|,| for | development| framework)/) ||
    q.match(/(?:have you|did you)\s+(?:used|use)\s+([a-z0-9.+#\/ -]{2,40}?)\s*(?:\?|$|\.|,| for )/);
  return m ? m[1].trim() : null;
}

function resumeMentions(profile, skill, norm) {
  return norm(profile.resumeText).includes(norm(skill));
}

// Day after last working date if set, otherwise today + notice period ("30 Days", "2 Months").
function earliestJoiningDate(profile) {
  const fmt = (d) => d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

  if (profile.employmentStatus === "Not currently working") return "Immediately";
  if (profile.lastWorkingDate) {
    const lwd = new Date(profile.lastWorkingDate);
    if (!isNaN(lwd)) return fmt(new Date(lwd.getTime() + 86400000));
  }
  const notice = String(profile.noticePeriod || "").toLowerCase();
  const n = parseFloat(notice) || 0;
  const days = /month/.test(notice) ? n * 30 : /week/.test(notice) ? n * 7 : n;
  return days ? fmt(new Date(Date.now() + days * 86400000)) : "Immediately";
}

// ---------- Plain (non-chatbot) forms ----------

function hasVisibleFormInputs() {
  return [...document.querySelectorAll('.modal input[type="text"], .modal textarea, [role="dialog"] input[type="text"], [role="dialog"] textarea')]
    .some(isVisible);
}

async function fillScreeningForms(userProfile, answers) {
  const inputs = document.querySelectorAll(
    'input[type="text"], input[type="number"], textarea, [contenteditable="true"]'
  );

  for (const input of inputs) {
    const current = input.isContentEditable ? input.innerText : input.value;
    if (current.trim() !== '' || !isVisible(input)) continue;

    const labelText = getQuestionText(input);
    if (!labelText) continue;

    const answer = ruleAnswer(labelText, userProfile) ||
      await requestAIAnswer(labelText, userProfile, answers, {
        inputType: input.type === "number" ? "number" : "text"
      });
    if (answer) {
      await setInputValue(input, answer);
      answers.push({ question: labelText, answer });
    }
  }

  // Click Submit / Save if a form is open
  const submitBtn = document.querySelector('button[type="submit"], .submit-btn, .modal-footer button');
  if (submitBtn) await realClick(submitBtn);
}

// Finds the question for an input: its <label>, aria-label, placeholder, or the
// nearest short block of text above it.
function getQuestionText(input) {
  if (input.id) {
    const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
    if (label) return label.innerText.trim();
  }
  const own = input.closest('label')?.innerText || input.getAttribute('aria-label') || input.placeholder;
  if (own?.trim()) return own.trim();

  let el = input.parentElement;
  for (let depth = 0; el && depth < 4; depth++, el = el.parentElement) {
    const text = el.innerText.trim();
    if (text && text.length < 300) return text;
  }
  return "";
}

// ---------- Helpers ----------

// Types an answer: click into the box, select what's there, then type with real keystrokes.
async function setInputValue(element, val) {
  val = String(val);
  await realClick(element);
  element.focus();
  selectAllIn(element);
  if (await sendRealInput({ type: "text", text: val })) {
    await delay(200);
    const typed = element.isContentEditable ? element.innerText : element.value;
    if (typed.trim() === val.trim()) {
      element.style.border = "2px solid #10b981";
      return;
    }
  }
  scriptSetValue(element, val); // fallback
}

function selectAllIn(element) {
  if (element.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    element.select?.();
  }
}

// The old way: set the value from script and announce it with script events.
function scriptSetValue(element, val) {
  element.focus();
  if (element.isContentEditable) {
    // Select just this box's contents (not the whole page), then type over it.
    // insertText fires the same events as real typing, which the chatbot listens for.
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, val);

    if (element.innerText.trim() !== String(val).trim()) {
      // Typing didn't land (e.g. no focus): set the text and announce it like typing would.
      element.innerText = val;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(val) }));
    }
  } else {
    // Use the native setter so React-controlled inputs register the change.
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(element, val);
  }
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  // Some chat boxes only enable Save on key events.
  element.dispatchEvent(new KeyboardEvent('keyup', { key: val.slice(-1), bubbles: true }));
  element.style.border = "2px solid #10b981";
}

// Last AI failure, shown in the "couldn't answer" log line.
let lastAIError = "";

// Asks the AI to answer one question from your profile + resume.
// answers: earlier Q&A in this application, for context.
// opts: { options: [labels], multi: bool, inputType: "number" | "text" }
function requestAIAnswer(question, profile, answers = [], opts = {}) {
  const data = {
    question,
    options: opts.options || [],
    multi: !!opts.multi,
    inputType: opts.inputType || "text",
    jobTitle: document.title,
    earliestJoiningDate: earliestJoiningDate(profile),
    previous: answers.slice(-8)
  };
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: "GENERATE_ANSWER", data },
      (res) => {
        lastAIError = chrome.runtime.lastError?.message || res?.error ||
          (res?.answer ? "" : "empty reply");
        resolve(res?.answer || "");
      }
    );
  });
}

async function waitFor(check, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = check();
    if (result) return result;
    await delay(400);
  }
  return null;
}

const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
const splitList = (text) => (text || "").split(',').map(s => s.trim()).filter(Boolean);
const delay = (ms) => new Promise(res => setTimeout(res, ms));
