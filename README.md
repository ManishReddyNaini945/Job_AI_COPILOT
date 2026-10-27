# Job AI Co-Pilot

A Chrome extension (Manifest V3) that searches Naukri for jobs matching your resume and preferences, applies to them, and answers the screening questions using your resume and saved details (with Groq AI for unusual questions).

## Setup

1. Clone the repo.
2. Copy `config.example.js` to `config.js` and put your Groq API key in it (get one at https://console.groq.com/keys). `config.js` is git-ignored, so the key is never committed.
3. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose this folder.
4. Click the extension icon, upload your resume (PDF or .txt), fill in the details that aren't in a resume (CTC, notice period, etc.), and click **Save Profile & Preferences**.
5. Open any naukri.com tab and click **Start Auto-Apply**.

## How it works

| File | Role |
|---|---|
| `manifest.json` | Extension config and permissions |
| `background.js` | Runs the searches, matches jobs, opens each job tab, calls Groq, sends real mouse/keyboard input via `chrome.debugger`, enforces the daily quota |
| `content.js` | Runs on Naukri pages: reads job cards, clicks Apply, reads and answers screening questions |
| `popup/` | Settings, resume upload, job log, CSV export, Start / Stop |
| `lib/` | [pdf.js](https://github.com/mozilla/pdf.js) 4.10.38 (Apache-2.0) to read resume PDFs |

- Jobs are matched when your experience fits the job's range and the title matches one of your roles or any of your skills appear.
- Common questions are answered from your saved details by built-in rules; everything else goes to Groq with your resume. Answers are cached to save requests.
- At most 50 applications per day. "Apply on company site" jobs are saved with their link for you to apply yourself.

## Notes

- Chrome shows a "started debugging this browser" bar while a job is being applied to; this is the `chrome.debugger` real-input feature.
- Automated applying may be against Naukri's terms of use and can put your account at risk. Use the daily limit and keep an eye on runs.
