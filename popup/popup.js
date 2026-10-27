document.addEventListener('DOMContentLoaded', () => {
  let statusTimer; // used by showStatus()

  // Today's applications vs the daily quota (must match DAILY_LIMIT in background.js).
  const DAILY_LIMIT = 50;
  // Same rule as getTodayCount() in background.js: only submitted applications
  // ("Applied" / "Applied (not confirmed - check)") count towards the quota.
  function renderQuota({ dailyQuota, appliedJobs = [] }) {
    const today = new Date().toLocaleDateString();
    const todays = appliedJobs.filter(j => j.appliedDate === today);
    const counter = dailyQuota?.date === new Date().toLocaleDateString("en-CA") ? dailyQuota.count : 0;
    const count = Math.max(counter, todays.filter(j => /^Applied/.test(j.status)).length);
    const companySite = todays.filter(j => j.status === "Apply on company site").length;
    const manual = todays.filter(j => j.status === "Apply manually").length;

    const el = document.getElementById('quotaInfo');
    const extras = [companySite && `${companySite} company site`, manual && `${manual} manual`].filter(Boolean);
    el.innerText = (count >= DAILY_LIMIT
      ? `Daily quota reached: ${count} / ${DAILY_LIMIT} applied today`
      : `Today: ${count} / ${DAILY_LIMIT} applied`) + (extras.length ? ` · ${extras.join(" · ")}` : "");
    el.classList.toggle('reached', count >= DAILY_LIMIT);
  }
  const refreshQuota = () => chrome.storage.local.get(['dailyQuota', 'appliedJobs'], renderQuota);
  refreshQuota();
  // Keep it live while a run is going.
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.dailyQuota || changes.appliedJobs) refreshQuota();
    if (changes.appliedJobs) renderAppliedHistory(changes.appliedJobs.newValue || []);
  });

  // Load saved profile and applied history on popup launch
  chrome.storage.local.get(['userProfile', 'resumeText', 'appliedJobs'], (result) => {
    const profile = result.userProfile || {};
    fillForm(profile);
    renderResumeInfo(profile, result.resumeText);
    renderAppliedHistory(result.appliedJobs || []);
  });

  // Only the fields a resume can't provide are in the form. Experience, skills, company,
  // designation and summary come from the resume (saved by background.js on upload).
  const FORM_FIELDS = {
    // Search
    targetRole: '', targetLocation: '', jobAge: '3',
    // Salary & joining
    currentCTC: '', expectedCTC: '', fixedSalary: '', noticePeriod: '', noticeNegotiable: 'Yes',
    employmentStatus: 'Employed', lastWorkingDate: '', competingOffers: 'No', reasonForChange: '',
    // Personal
    dob: '', gender: '', maritalStatus: '', hometown: '', languages: '', passport: '', careerGap: 'No',
    // Work preferences
    willingToRelocate: 'Yes', workMode: 'Any', workFromOffice: 'Yes', shifts: 'Yes', travel: 'Yes',
    // Education scores & links
    tenthScore: '', twelfthScore: '', gradScore: '', linkedin: '', portfolio: ''
  };

  function fillForm(p) {
    for (const [id, fallback] of Object.entries(FORM_FIELDS)) {
      document.getElementById(id).value = p[id] || fallback;
    }
  }

  function renderResumeInfo(p, resumeText) {
    const box = document.getElementById('resumeInfo');
    if (!resumeText) {
      box.className = 'resume-info';
      box.innerText = 'No resume uploaded yet.';
      return;
    }
    box.className = 'resume-info loaded';
    box.innerText = [
      '✓ Resume loaded',
      p.totalExp && `Experience: ${p.totalExp}`,
      p.skills && `Skills: ${p.skills}`,
      (p.currentDesignation || p.currentCompany) &&
        `Current: ${[p.currentDesignation, p.currentCompany].filter(Boolean).join(' @ ')}`
    ].filter(Boolean).join('\n');
  }

  // Resume upload: the PDF's text is pulled out here with pdf.js (lib/), then background.js
  // has Groq read it, and stores the text (for answering questions) and the details found.
  //
  // On some systems the toolbar popup closes when the OS file chooser takes focus, which
  // kills the upload. The "Open in a tab" link reopens this same page in a normal tab.
  const isTabMode = new URLSearchParams(location.search).get('mode') === 'tab';

  if (isTabMode) {
    document.getElementById('openTabHint').hidden = true;
    document.body.classList.add('tab-mode');
  }

  document.getElementById('openInTabLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html?mode=tab') });
    window.close();
  });

  document.getElementById('resumeFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    let text;
    try {
      if (file.type === 'application/pdf') {
        showStatus("Reading resume...", true);
        text = await pdfToText(file);
      } else if (file.type === 'text/plain' || file.name.toLowerCase().endsWith('.txt')) {
        text = await file.text();
      } else {
        alert("Please upload a PDF or .txt file. (For Word files: File → Save As → PDF.)");
        return;
      }
    } catch (err) {
      showStatus("");
      alert(`Couldn't open the file: ${err.message}`);
      return;
    }

    showStatus("Reading resume with AI... (a few seconds)", true);
    chrome.runtime.sendMessage({ action: "EXTRACT_PROFILE", text }, (res) => {
      if (chrome.runtime.lastError || !res?.success) {
        showStatus("");
        alert(`Couldn't read the resume: ${chrome.runtime.lastError?.message || res?.error || "unknown error"}`);
        return;
      }
      fillForm(res.profile);
      renderResumeInfo(res.profile, true);
      showStatus("Resume saved. Fill in CTC, notice period etc., then Save.");
    });
  });

  // Extracts the text of every page of a PDF with pdf.js (bundled in lib/, since
  // extensions can't load code from the internet).
  async function pdfToText(file) {
    const pdfjsLib = await import(chrome.runtime.getURL('lib/pdf.min.mjs'));
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const content = await (await pdf.getPage(n)).getTextContent();
      pages.push(content.items.map(item => item.str + (item.hasEOL ? '\n' : ' ')).join(''));
    }
    return pages.join('\n\n').replace(/[ \t]+/g, ' ').trim();
  }

  // Render applied companies list dynamically
  function renderAppliedHistory(jobs) {
    const historyContainer = document.getElementById('appliedHistory');
    const countSpan = document.getElementById('appliedCount');

    // e.g. "24 total · 10 applied": the log also holds company-site and manual jobs.
    const submitted = jobs.filter(j => /^Applied/.test(j.status)).length;
    countSpan.innerText = `${jobs.length} total · ${submitted} applied`;

    if (jobs.length === 0) {
      historyContainer.innerHTML = '<p class="empty-msg">No job applications logged yet.</p>';
      return;
    }

    historyContainer.innerHTML = jobs.map(job => {
      // Why it wasn't submitted, e.g. 'stuck on: "DOB" [box has "...", Save still grey]'
      // (stored after " | " in the description).
      const reason = /^Apply manually|not confirmed/.test(job.status)
        ? (job.description || "").split(" | ").slice(1).join(" | ")
        : "";
      return `
      <div class="history-item">
        <div class="job-info">
          <strong>${escapeHtml(job.companyName)}</strong>
          <span class="job-role">${escapeHtml(job.role)}</span>
          ${job.status !== "Applied" ? `<span class="job-role">↗ ${escapeHtml(job.status)}</span>` : ''}
          ${reason ? `<span class="job-reason" title="${escapeHtml(reason)}">${escapeHtml(reason)}</span>` : ''}
        </div>
        <span class="job-date">${escapeHtml(job.appliedDate)}</span>
      </div>`;
    }).reverse().join('');
  }

  // Page text (company names, questions) goes into innerHTML, so escape it.
  function escapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, ch =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  }

  // Save Settings
  document.getElementById('saveBtn').addEventListener('click', () => {
    chrome.storage.local.get(['userProfile'], ({ userProfile: saved = {} }) => {
      // Keep the resume-derived details; overwrite only what's in the form.
      const userProfile = { ...saved };
      for (const id of Object.keys(FORM_FIELDS)) {
        userProfile[id] = document.getElementById(id).value;
      }

      // answerCache holds AI answers based on the old details; start fresh.
      chrome.storage.local.set({ userProfile, answerCache: {} }, () => {
        showStatus("Settings Saved Successfully!");
      });
    });
  });

  // Start Full Automated Navigation Flow
  document.getElementById('startAutoApplyBtn').addEventListener('click', () => {
    chrome.storage.local.get(['userProfile', 'resumeText'], (result) => {
      const profile = result.userProfile;
      if (!result.resumeText || !profile?.totalExp) {
        alert("Please upload your resume first.");
        return;
      }
      if (!profile.targetRole || !profile.targetLocation) {
        alert("Please fill in Target Roles and Preferred Locations, then click Save Profile & Preferences!");
        return;
      }

      chrome.runtime.sendMessage({
        action: "LAUNCH_AUTO_SEARCH",
        preferences: profile
      }, (response) => {
        if (response?.quotaReached) {
          showStatus("");
          alert(response.status);
          return;
        }
        showStatus(response?.status || "Launching automated search...");
      });
    });
  });

  // Stop Trigger
  document.getElementById('stopAutoApplyBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: "STOP_AUTO_SEARCH" }, (response) => {
      showStatus(response?.status || "Stopped.");
    });
  });

  // Export Spreadsheet CSV
  document.getElementById('exportCsvBtn').addEventListener('click', () => {
    chrome.storage.local.get(['appliedJobs'], (result) => {
      const jobs = result.appliedJobs || [];

      if (jobs.length === 0) {
        alert("No applied jobs recorded yet!");
        return;
      }

      const cell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;

      let csvContent = "Company Name,Role,Experience,Status,Company Website (apply here),Naukri Job Link,Description,Time Taken,Date,Time\n";

      jobs.forEach(job => {
        const row = [
          job.companyName,
          job.role,
          job.experience,
          job.status,
          job.companyWebsite,
          job.url,
          job.description,
          job.timeTaken,
          job.appliedDate,
          job.appliedTime
        ].map(cell).join(",");
        csvContent += row + "\n";
      });

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);

      chrome.downloads.download({
        url: url,
        filename: `Applied_Jobs_${new Date().toISOString().slice(0,10)}.csv`,
        saveAs: true
      });
    });
  });

  // Clear history helper
  document.getElementById('clearJobsBtn').addEventListener('click', () => {
    if (confirm("Clear local application history?")) {
      chrome.storage.local.set({ appliedJobs: [] }, () => {
        renderAppliedHistory([]);
        showStatus("History cleared.");
      });
    }
  });

  // Re-opens every "Apply manually" job and marks it Applied if Naukri already shows it so.
  document.getElementById('recheckBtn').addEventListener('click', () => {
    showStatus("Re-checking jobs on Naukri... (a few seconds per job)", true);
    chrome.runtime.sendMessage({ action: "RECHECK_MANUAL" }, (response) => {
      showStatus(response?.status || "Re-check finished.");
    });
  });

  // Copies the last stuck question's drawer snapshot, to paste to the developer.
  document.getElementById('copyDebugBtn').addEventListener('click', () => {
    chrome.storage.local.get(['lastStuckDebug'], async ({ lastStuckDebug }) => {
      if (!lastStuckDebug) {
        alert("No stuck question recorded yet.");
        return;
      }
      try {
        await navigator.clipboard.writeText(JSON.stringify(lastStuckDebug, null, 2));
        showStatus("Debug info copied. Paste it to your developer.");
      } catch (err) {
        alert(`Couldn't copy: ${err.message}`);
      }
    });
  });

  // keep = true leaves the message up (e.g. while the AI reads the resume).
  function showStatus(text, keep = false) {
    const status = document.getElementById('status');
    status.innerText = text;
    clearTimeout(statusTimer);
    if (!keep) statusTimer = setTimeout(() => status.innerText = "", 4000);
  }
});